import Collection from 'xo-collection'
import createDebug from 'debug'
import kindOf from 'kindof'
import ms from 'ms'
import httpRequest from 'http-request-plus'
import { BaseError } from 'make-error'
import { EventEmitter } from 'events'
import { fibonacci } from 'iterable-backoff'
import {
  filter,
  forEach,
  isArray,
  isInteger,
  map,
  noop,
  omit,
  reduce,
  startsWith,
} from 'lodash'
import {
  Cancel,
  cancelable,
  defer,
  fromEvents,
  pCatch,
  pDelay,
  pFinally,
  pTimeout,
  TimeoutError,
} from 'promise-toolbox'

import autoTransport from './transports/auto'

const debug = createDebug('xen-api')

// ===================================================================

// in seconds
const EVENT_TIMEOUT = 60

// http://www.gnu.org/software/libc/manual/html_node/Error-Codes.html
const NETWORK_ERRORS = {
  // Connection has been closed outside of our control.
  ECONNRESET: true,

  // Connection has been aborted locally.
  ECONNABORTED: true,

  // Host is up but refuses connection (typically: no such service).
  ECONNREFUSED: true,

  // TODO: ??
  EINVAL: true,

  // Host is not reachable (does not respond).
  EHOSTUNREACH: true,

  // network is unreachable
  ENETUNREACH: true,

  // Connection configured timed out has been reach.
  ETIMEDOUT: true,
}

const isNetworkError = ({ code }) => NETWORK_ERRORS[code]

// -------------------------------------------------------------------

const XAPI_NETWORK_ERRORS = {
  HOST_STILL_BOOTING: true,
  HOST_HAS_NO_MANAGEMENT_IP: true,
}

const isXapiNetworkError = ({ code }) => XAPI_NETWORK_ERRORS[code]

// -------------------------------------------------------------------

const areEventsLost = ({ code }) => code === 'EVENTS_LOST'

const isHostSlave = ({ code }) => code === 'HOST_IS_SLAVE'

const isMethodUnknown = ({ code }) => code === 'MESSAGE_METHOD_UNKNOWN'

const isSessionInvalid = ({ code }) => code === 'SESSION_INVALID'

// -------------------------------------------------------------------

class XapiError extends BaseError {
  constructor (code, params) {
    super(`${code}(${params.join(', ')})`)

    this.code = code
    this.params = params

    // slots than can be assigned later
    this.method = undefined
    this.url = undefined
    this.task = undefined
  }
}

export const wrapError = error => {
  let code, params
  if (isArray(error)) {
    // < XenServer 7.3
    ;[code, ...params] = error
  } else {
    code = error.message
    params = error.data
  }
  return new XapiError(code, params)
}

// ===================================================================

const URL_RE = /^(?:(https?:)\/*)?(?:([^:]+):([^@]+)@)?([^/]+?)(?::([0-9]+))?\/?$/
const parseUrl = url => {
  const matches = URL_RE.exec(url)
  if (!matches) {
    throw new Error('invalid URL: ' + url)
  }

  const [, protocol = 'https:', username, password, hostname, port] = matches
  const parsedUrl = { protocol, hostname, port }
  if (username !== undefined) {
    parsedUrl.username = decodeURIComponent(username)
  }
  if (password !== undefined) {
    parsedUrl.password = decodeURIComponent(password)
  }
  return parsedUrl
}

// -------------------------------------------------------------------

const {
  create: createObject,
  defineProperties,
  freeze: freezeObject,
  keys: getKeys,
} = Object

// -------------------------------------------------------------------

export const NULL_REF = 'OpaqueRef:NULL'

const OPAQUE_REF_PREFIX = 'OpaqueRef:'
export const isOpaqueRef = value =>
  typeof value === 'string' && startsWith(value, OPAQUE_REF_PREFIX)

// -------------------------------------------------------------------

const isGetAllRecordsMethod = RegExp.prototype.test.bind(/\.get_all_records$/)

const RE_READ_ONLY_METHOD = /^[^.]+\.get_/
const isReadOnlyCall = (method, args) =>
  args.length === 1 &&
  typeof args[0] === 'string' &&
  RE_READ_ONLY_METHOD.test(method)

// Prepare values before passing them to the XenAPI:
//
// - cast integers to strings
const prepareParam = param => {
  if (isInteger(param)) {
    return String(param)
  }

  if (typeof param !== 'object' || param === null) {
    return param
  }

  if (isArray(param)) {
    return map(param, prepareParam)
  }

  const values = {}
  forEach(param, (value, key) => {
    if (value !== undefined) {
      values[key] = prepareParam(value)
    }
  })
  return values
}

// -------------------------------------------------------------------

const getKey = o => o.$id

// -------------------------------------------------------------------

const getTaskResult = task => {
  const { status } = task
  if (status === 'cancelled') {
    return Promise.reject(new Cancel('task canceled'))
  }
  if (status === 'failure') {
    const error = wrapError(task.error_info)
    error.task = task
    return Promise.reject(error)
  }
  if (status === 'success') {
    // the result might be:
    // - empty string
    // - an opaque reference
    // - an XML-RPC value
    return Promise.resolve(task.result)
  }
}

// -------------------------------------------------------------------

const RESERVED_FIELDS = {
  id: true,
  pool: true,
  ref: true,
  type: true,
}

// -------------------------------------------------------------------

const CONNECTED = 'connected'
const CONNECTING = 'connecting'
const DISCONNECTED = 'disconnected'

// -------------------------------------------------------------------

export class Xapi extends EventEmitter {
  constructor (opts) {
    super()

    this._allowUnauthorized = opts.allowUnauthorized
    this._auth = opts.auth
    this._pool = null
    this._readOnly = Boolean(opts.readOnly)
    this._RecordsByType = createObject(null)
    this._sessionId = null
    const url = (this._url = parseUrl(opts.url))

    if (this._auth === undefined) {
      const user = url.username
      if (user !== undefined) {
        this._auth = {
          user,
          password: url.password,
        }
        delete url.username
        delete url.password
      }
    }

    if (opts.watchEvents !== false) {
      this._debounce = opts.debounce == null ? 200 : opts.debounce

      this._eventWatchers = createObject(null)

      this._fromToken = ''

      // Memoize this function _addObject().
      this._getPool = () => this._pool

      this._nTasks = 0

      const objects = (this._objects = new Collection())
      objects.getKey = getKey

      this._objectsByRef = createObject(null)
      this._objectsByRef[NULL_REF] = undefined

      this._taskWatchers = Object.create(null)

      this.on('connected', this._watchEvents)
      this.on('disconnected', () => {
        this._fromToken = ''
        objects.clear()
      })
    }
  }

  get _url () {
    return this.__url
  }

  set _url (url) {
    this.__url = url
    this._call = autoTransport({
      allowUnauthorized: this._allowUnauthorized,
      url,
    })
  }

  get readOnly () {
    return this._readOnly
  }

  set readOnly (ro) {
    this._readOnly = Boolean(ro)
  }

  get sessionId () {
    const id = this._sessionId

    if (!id || id === CONNECTING) {
      throw new Error('sessionId is only available when connected')
    }

    return id
  }

  get status () {
    const id = this._sessionId

    return id ? (id === CONNECTING ? CONNECTING : CONNECTED) : DISCONNECTED
  }

  get _humanId () {
    return `${this._auth.user}@${this._url.hostname}`
  }

  // ensure we have received all events up to this call
  //
  // optionally returns the up to date object for the given ref
  barrier (ref) {
    const eventWatchers = this._eventWatchers
    if (eventWatchers === undefined) {
      return Promise.reject(
        new Error('Xapi#barrier() requires events watching')
      )
    }

    const key = `xo:barrier:${Math.random()
      .toString(36)
      .slice(2)}`
    const poolRef = this._pool.$ref

    const { promise, resolve } = defer()
    eventWatchers[key] = resolve

    return this._sessionCall('pool.add_to_other_config', [
      poolRef,
      key,
      '',
    ]).then(() =>
      promise.then(() => {
        this._sessionCall('pool.remove_from_other_config', [
          poolRef,
          key,
        ]).catch(noop)

        if (ref === undefined) {
          return
        }

        // support legacy params (type, ref)
        if (arguments.length === 2) {
          ref = arguments[1]
        }

        return this.getObjectByRef(ref)
      })
    )
  }

  connect () {
    const { status } = this

    if (status === CONNECTED) {
      return Promise.reject(new Error('already connected'))
    }

    if (status === CONNECTING) {
      return Promise.reject(new Error('already connecting'))
    }

    const auth = this._auth
    if (auth === undefined) {
      return Promise.reject(new Error('missing credentials'))
    }

    this._sessionId = CONNECTING

    return this._transportCall('session.login_with_password', [
      auth.user,
      auth.password,
    ]).then(
      sessionId => {
        this._sessionId = sessionId

        debug('%s: connected', this._humanId)

        this.emit(CONNECTED)
      },
      error => {
        this._sessionId = null

        throw error
      }
    )
  }

  disconnect () {
    return Promise.resolve().then(() => {
      const { status } = this

      if (status === DISCONNECTED) {
        return Promise.reject(new Error('already disconnected'))
      }

      this._transportCall('session.logout', [this._sessionId]).catch(noop)

      this._sessionId = null

      debug('%s: disconnected', this._humanId)

      this.emit(DISCONNECTED)
    })
  }

  // High level calls.
  call (method, ...args) {
    return this._readOnly && !isReadOnlyCall(method, args)
      ? Promise.reject(new Error(`cannot call ${method}() in read only mode`))
      : this._sessionCall(method, prepareParam(args))
  }

  @cancelable
  callAsync ($cancelToken, method, ...args) {
    return this._readOnly && !isReadOnlyCall(method, args)
      ? Promise.reject(new Error(`cannot call ${method}() in read only mode`))
      : this._sessionCall(`Async.${method}`, args).then(taskRef => {
          $cancelToken.promise.then(() => {
            // TODO: do not trigger if the task is already over
            this._sessionCall('task.cancel', [taskRef]).catch(noop)
          })

          return pFinally.call(this.watchTask(taskRef), () => {
            this._sessionCall('task.destroy', [taskRef]).catch(noop)
          })
        })
  }

  // create a task and automatically destroy it when settled
  //
  //  allowed even in read-only mode because it does not have impact on the
  //  XenServer and it's necessary for getResource()
  createTask (nameLabel, nameDescription = '') {
    const promise = this._sessionCall('task.create', [
      nameLabel,
      nameDescription,
    ])

    promise.then(taskRef => {
      const destroy = () =>
        this._sessionCall('task.destroy', [taskRef]).catch(noop)
      this.watchTask(taskRef).then(destroy, destroy)
    })

    return promise
  }

  // Nice getter which returns the object for a given $id (internal to
  // this lib), UUID (unique identifier that some objects have) or
  // opaque reference (internal to XAPI).
  getObject (idOrUuidOrRef, defaultValue) {
    if (typeof idOrUuidOrRef === 'object') {
      idOrUuidOrRef = idOrUuidOrRef.$id
    }

    const object =
      this._objects.all[idOrUuidOrRef] || this._objectsByRef[idOrUuidOrRef]

    if (object !== undefined) return object

    if (arguments.length > 1) return defaultValue

    throw new Error('no object with UUID or opaque ref: ' + idOrUuidOrRef)
  }

  // Returns the object for a given opaque reference (internal to
  // XAPI).
  getObjectByRef (ref, defaultValue) {
    const object = this._objectsByRef[ref]

    if (object !== undefined) return object

    if (arguments.length > 1) return defaultValue

    throw new Error('no object with opaque ref: ' + ref)
  }

  // Returns the object for a given UUID (unique identifier that some
  // objects have).
  getObjectByUuid (uuid, defaultValue) {
    // Objects ids are already UUIDs if they have one.
    const object = this._objects.all[uuid]

    if (object) return object

    if (arguments.length > 1) return defaultValue

    throw new Error('no object with UUID: ' + uuid)
  }

  async getRecord (type, ref) {
    return this._wrapRecord(
      await this._sessionCall(`${type}.get_record`, [ref])
    )
  }

  async getRecordByUuid (type, uuid) {
    return this.getRecord(
      type,
      await this._sessionCall(`${type}.get_by_uuid`, [uuid])
    )
  }

  @cancelable
  getResource ($cancelToken, pathname, { host, query, task }) {
    return this._autoTask(task, `Xapi#getResource ${pathname}`).then(
      taskRef => {
        query = { ...query, session_id: this.sessionId }
        let taskResult
        if (taskRef !== undefined) {
          query.task_id = taskRef
          taskResult = this.watchTask(taskRef)

          if (typeof $cancelToken.addHandler === 'function') {
            $cancelToken.addHandler(() => taskResult)
          }
        }

        let promise = httpRequest(
          $cancelToken,
          this._url,
          host && {
            hostname: this.getObject(host).address,
          },
          {
            pathname,
            query,
            rejectUnauthorized: !this._allowUnauthorized,
          }
        )

        if (taskResult !== undefined) {
          promise = promise.then(response => {
            response.task = taskResult
            return response
          })
        }

        return promise
      }
    )
  }

  @cancelable
  putResource ($cancelToken, body, pathname, { host, query, task } = {}) {
    if (this._readOnly) {
      return Promise.reject(
        new Error(new Error('cannot put resource in read only mode'))
      )
    }

    return this._autoTask(task, `Xapi#putResource ${pathname}`).then(
      taskRef => {
        query = { ...query, session_id: this.sessionId }

        let taskResult
        if (taskRef !== undefined) {
          query.task_id = taskRef
          taskResult = this.watchTask(taskRef)

          if (typeof $cancelToken.addHandler === 'function') {
            $cancelToken.addHandler(() => taskResult)
          }
        }

        const headers = {}

        // Xen API does not support chunk encoding.
        const isStream = typeof body.pipe === 'function'
        const { length } = body
        if (isStream && length === undefined) {
          // add a fake huge content length (1 PiB)
          headers['content-length'] = '1125899906842624'
        }

        const doRequest = (...opts) =>
          httpRequest.put(
            $cancelToken,
            this._url,
            host && {
              hostname: this.getObject(host).address,
            },
            {
              body,
              headers,
              query,
              pathname,
              maxRedirects: 0,
              rejectUnauthorized: !this._allowUnauthorized,
            },
            ...opts
          )

        // if a stream, sends a dummy request to probe for a
        // redirection before consuming body
        const promise = isStream
          ? doRequest({
              body: '',

              // omit task_id because this request will fail on purpose
              query: 'task_id' in query ? omit(query, 'task_id') : query,
            }).then(
              response => {
                response.req.abort()
                return doRequest()
              },
              error => {
                let response
                if (error != null && (response = error.response) != null) {
                  response.req.abort()

                  const {
                    headers: { location },
                    statusCode,
                  } = response
                  if (statusCode === 302 && location !== undefined) {
                    // ensure the original query is sent
                    return doRequest(location, { query })
                  }
                }

                throw error
              }
            )
          : doRequest()

        return promise.then(response => {
          const { req } = response

          if (taskResult !== undefined) {
            taskResult = taskResult.catch(error => {
              error.url = response.url
              throw error
            })
          }

          if (req.finished) {
            req.abort()
            return taskResult
          }

          return fromEvents(req, ['close', 'finish']).then(() => {
            req.abort()
            return taskResult
          })
        })
      }
    )
  }

  setField ({ $type, $ref }, field, value) {
    return this.call(`${$type}.set_${field}`, $ref, value).then(noop)
  }

  setFieldEntries (record, field, entries) {
    return Promise.all(
      getKeys(entries).map(entry => {
        const value = entries[entry]
        if (value !== undefined) {
          return value === null
            ? this.unsetFieldEntry(record, field, entry)
            : this.setFieldEntry(record, field, entry, value)
        }
      })
    ).then(noop)
  }

  async setFieldEntry ({ $type, $ref }, field, entry, value) {
    while (true) {
      try {
        await this.call(`${$type}.add_to_${field}`, $ref, entry, value)
        return
      } catch (error) {
        if (error == null || error.code !== 'MAP_DUPLICATE_KEY') {
          throw error
        }
      }
      await this.unsetFieldEntry({ $type, $ref }, field, entry)
    }
  }

  unsetFieldEntry ({ $type, $ref }, field, entry) {
    return this.call(`${$type}.remove_from_${field}`, $ref, entry)
  }

  watchTask (ref) {
    const watchers = this._taskWatchers
    if (watchers === undefined) {
      throw new Error('Xapi#watchTask() requires events watching')
    }

    // allow task object to be passed
    if (ref.$ref !== undefined) ref = ref.$ref

    let watcher = watchers[ref]
    if (watcher === undefined) {
      // sync check if the task is already settled
      const task = this._objectsByRef[ref]
      if (task !== undefined) {
        const result = getTaskResult(task)
        if (result !== undefined) {
          return result
        }
      }

      watcher = watchers[ref] = defer()
    }
    return watcher.promise
  }

  get pool () {
    return this._pool
  }

  get objects () {
    return this._objects
  }

  // return a promise which resolves to a task ref or undefined
  _autoTask (task = this._taskWatchers !== undefined, name) {
    if (task === false) {
      return Promise.resolve()
    }

    if (task === true) {
      return this.createTask(name)
    }

    // either a reference or a promise to a reference
    return Promise.resolve(task)
  }

  // Medium level call: handle session errors.
  _sessionCall (method, args) {
    try {
      if (startsWith(method, 'session.')) {
        throw new Error('session.*() methods are disabled from this interface')
      }

      const newArgs = [this.sessionId]
      if (args !== undefined) {
        newArgs.push.apply(newArgs, args)
      }

      return pCatch.call(
        this._transportCall(method, newArgs),
        isSessionInvalid,
        () => {
          // XAPI is sometimes reinitialized and sessions are lost.
          // Try to login again.
          debug('%s: the session has been reinitialized', this._humanId)

          this._sessionId = null
          return this.connect().then(() => this._sessionCall(method, args))
        }
      )
    } catch (error) {
      return Promise.reject(error)
    }
  }

  _addObject (type, ref, object) {
    object = this._wrapRecord(type, ref, object)

    // Finally freezes the object.
    freezeObject(object)

    const objects = this._objects
    const objectsByRef = this._objectsByRef

    // An object's UUID can change during its life.
    const prev = objectsByRef[ref]
    let prevUuid
    if (prev && (prevUuid = prev.uuid) && prevUuid !== object.uuid) {
      objects.remove(prevUuid)
    }

    this._objects.set(object)
    objectsByRef[ref] = object

    if (type === 'pool') {
      this._pool = object

      const eventWatchers = this._eventWatchers
      getKeys(object.other_config).forEach(key => {
        const eventWatcher = eventWatchers[key]
        if (eventWatcher !== undefined) {
          delete eventWatchers[key]
          eventWatcher(object)
        }
      })
    } else if (type === 'task') {
      if (prev === undefined) {
        ++this._nTasks
      }

      const taskWatchers = this._taskWatchers
      const taskWatcher = taskWatchers[ref]
      if (taskWatcher !== undefined) {
        const result = getTaskResult(object)
        if (result !== undefined) {
          taskWatcher.resolve(result)
          delete taskWatchers[ref]
        }
      }
    }
  }

  _removeObject (type, ref) {
    const byRefs = this._objectsByRef
    const object = byRefs[ref]
    if (object !== undefined) {
      this._objects.unset(object.$id)
      delete byRefs[ref]

      if (type === 'task') {
        --this._nTasks
      }
    }

    const taskWatchers = this._taskWatchers
    const taskWatcher = taskWatchers[ref]
    if (taskWatcher !== undefined) {
      const error = new Error('task has been destroyed before completion')
      error.task = object
      error.taskRef = ref
      taskWatcher.reject(error)
      delete taskWatchers[ref]
    }
  }

  _processEvents (events) {
    forEach(events, event => {
      const { class: type, ref } = event
      if (event.operation === 'del') {
        this._removeObject(type, ref)
      } else {
        this._addObject(type, ref, event.snapshot)
      }
    })
  }

  _watchEvents () {
    const loop = () =>
      this.status === CONNECTED &&
      pTimeout
        .call(
          this._sessionCall('event.from', [
            ['*'],
            this._fromToken,
            EVENT_TIMEOUT + 0.1, // Force float.
          ]),
          EVENT_TIMEOUT * 1.1e3 // 10% longer than the XenAPI timeout
        )
        .then(onSuccess, onFailure)

    const onSuccess = ({ events, token, valid_ref_counts: { task } }) => {
      this._fromToken = token
      this._processEvents(events)

      if (task !== this._nTasks) {
        this._sessionCall('task.get_all_records')
          .then(tasks => {
            const toRemove = new Set()
            forEach(this.objects.all, object => {
              if (object.$type === 'task') {
                toRemove.add(object.$ref)
              }
            })
            forEach(tasks, (task, ref) => {
              toRemove.delete(ref)
              this._addObject('task', ref, task)
            })
            toRemove.forEach(ref => {
              this._removeObject('task', ref)
            })
          })
          .catch(noop)
      }

      const debounce = this._debounce
      return debounce != null ? pDelay(debounce).then(loop) : loop()
    }
    const onFailure = error => {
      if (error instanceof TimeoutError) {
        return loop()
      }

      if (areEventsLost(error)) {
        this._fromToken = ''
        this._objects.clear()

        return loop()
      }

      throw error
    }

    return pCatch.call(
      loop(),
      isMethodUnknown,

      // If the server failed, it is probably due to an excessively
      // large response.
      // Falling back to legacy events watch should be enough.
      error => error && error.res && error.res.statusCode === 500,

      () => this._watchEventsLegacy()
    )
  }

  // This method watches events using the legacy `event.next` XAPI
  // methods.
  //
  // It also has to manually get all objects first.
  _watchEventsLegacy () {
    const getAllObjects = () => {
      return this._sessionCall('system.listMethods').then(methods => {
        // Uses introspection to determine the methods to use to get
        // all objects.
        const getAllRecordsMethods = filter(methods, isGetAllRecordsMethod)

        return Promise.all(
          map(getAllRecordsMethods, method =>
            this._sessionCall(method).then(
              objects => {
                const type = method.slice(0, method.indexOf('.')).toLowerCase()
                forEach(objects, (object, ref) => {
                  this._addObject(type, ref, object)
                })
              },
              error => {
                if (error.code !== 'MESSAGE_REMOVED') {
                  throw error
                }
              }
            )
          )
        )
      })
    }

    const watchEvents = () =>
      this._sessionCall('event.register', [['*']]).then(loop)

    const loop = () =>
      this.status === CONNECTED &&
      this._sessionCall('event.next').then(onSuccess, onFailure)

    const onSuccess = events => {
      this._processEvents(events)

      const debounce = this._debounce
      return debounce == null ? loop() : pDelay(debounce).then(loop)
    }

    const onFailure = error => {
      if (areEventsLost(error)) {
        return this._sessionCall('event.unregister', [['*']]).then(watchEvents)
      }

      throw error
    }

    return getAllObjects().then(watchEvents)
  }

  _wrapRecord (type, ref, data) {
    const RecordsByType = this._RecordsByType
    let Record = RecordsByType[type]
    if (Record === undefined) {
      const fields = getKeys(data)
      const nFields = fields.length
      const xapi = this

      const objectsByRef = this._objectsByRef
      const getObjectByRef = ref => objectsByRef[ref]

      Record = function (ref, data) {
        defineProperties(this, {
          $id: { value: data.uuid || ref },
          $ref: { value: ref },
        })
        for (let i = 0; i < nFields; ++i) {
          const field = fields[i]
          this[field] = data[field]
        }
      }

      const getters = { $pool: this._getPool }
      const props = { $type: type }
      fields.forEach(field => {
        props[`set_${field}`] = function (value) {
          return xapi.setField(this, field, value)
        }

        const $field = (field in RESERVED_FIELDS ? '$$' : '$') + field

        const value = data[field]
        if (isArray(value)) {
          if (value.length === 0 || isOpaqueRef(value[0])) {
            getters[$field] = function () {
              const value = this[field]
              return value.length === 0 ? value : value.map(getObjectByRef)
            }
          }

          props[`add_to_${field}`] = function (...values) {
            return xapi
              .call(`${type}.add_${field}`, this.$ref, values)
              .then(noop)
          }
        } else if (value !== null && typeof value === 'object') {
          getters[$field] = function () {
            const value = this[field]
            const result = {}
            getKeys(value).forEach(key => {
              result[key] = objectsByRef[value[key]]
            })
            return result
          }
          props[`update_${field}`] = function (entries) {
            return xapi.setFieldEntries(this, field, entries)
          }
        } else if (isOpaqueRef(value)) {
          getters[$field] = function () {
            return objectsByRef[this[field]]
          }
        }
      })
      const descriptors = {}
      getKeys(getters).forEach(key => {
        descriptors[key] = {
          configurable: true,
          get: getters[key],
        }
      })
      getKeys(props).forEach(key => {
        descriptors[key] = {
          configurable: true,
          value: props[key],
          writable: true,
        }
      })
      defineProperties(Record.prototype, descriptors)

      RecordsByType[type] = Record
    }
    return new Record(ref, data)
  }
}

Xapi.prototype._transportCall = reduce(
  [
    function (method, args) {
      return this._call(method, args).catch(error => {
        if (!(error instanceof Error)) {
          error = wrapError(error)
        }

        error.method = method
        throw error
      })
    },
    call =>
      function () {
        let iterator // lazily created
        const loop = () =>
          pCatch.call(
            call.apply(this, arguments),
            isNetworkError,
            isXapiNetworkError,
            error => {
              if (iterator === undefined) {
                iterator = fibonacci()
                  .clamp(undefined, 60)
                  .take(10)
                  .toMs()
              }

              const cursor = iterator.next()
              if (!cursor.done) {
                // TODO: ability to cancel the connection
                // TODO: ability to force immediate reconnection

                const delay = cursor.value
                debug(
                  '%s: network error %s, next try in %s ms',
                  this._humanId,
                  error.code,
                  delay
                )
                return pDelay(delay).then(loop)
              }

              debug('%s: network error %s, aborting', this._humanId, error.code)

              // mark as disconnected
              pCatch.call(this.disconnect(), noop)

              throw error
            }
          )
        return loop()
      },
    call =>
      function loop () {
        return pCatch.call(
          call.apply(this, arguments),
          isHostSlave,
          ({ params: [master] }) => {
            debug(
              '%s: host is slave, attempting to connect at %s',
              this._humanId,
              master
            )

            const newUrl = {
              ...this._url,
              hostname: master,
            }
            this.emit('redirect', newUrl)
            this._url = newUrl

            return loop.apply(this, arguments)
          }
        )
      },
    call =>
      function (method) {
        const startTime = Date.now()
        return call.apply(this, arguments).then(
          result => {
            debug(
              '%s: %s(...) [%s] ==> %s',
              this._humanId,
              method,
              ms(Date.now() - startTime),
              kindOf(result)
            )
            return result
          },
          error => {
            debug(
              '%s: %s(...) [%s] =!> %s',
              this._humanId,
              method,
              ms(Date.now() - startTime),
              error
            )
            throw error
          }
        )
      },
  ],
  (call, decorator) => decorator(call)
)

// ===================================================================

// The default value is a factory function.
export const createClient = opts => new Xapi(opts)
