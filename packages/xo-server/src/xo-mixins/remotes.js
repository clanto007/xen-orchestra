import synchronized from 'decorator-synchronized'
import { getHandler } from '@xen-orchestra/fs'
import { noSuchObject } from 'xo-common/api-errors'
import { ignoreErrors } from 'promise-toolbox'

import patch from '../patch'
import { mapToArray } from '../utils'
import { Remotes } from '../models/remote'

// ===================================================================

export default class {
  constructor (xo) {
    this._remotes = new Remotes({
      connection: xo._redis,
      prefix: 'xo:remote',
      indexes: ['enabled'],
    })
    this._handlers = { __proto__: null }

    xo.on('clean', () => this._remotes.rebuildIndexes())
    xo.on('start', async () => {
      xo.addConfigManager(
        'remotes',
        () => this._remotes.get(),
        remotes =>
          Promise.all(
            mapToArray(remotes, remote => this._remotes.update(remote))
          )
      )

      const remotes = await this.getAllRemotes()
      remotes.forEach(remote => {
        ignoreErrors.call(this.updateRemote(remote.id, {}))
      })
    })
    xo.on('stop', async () => {
      const handlers = this._handlers
      for (const id in handlers) {
        try {
          await handlers[id].forget()
        } catch (_) {}
      }
    })
  }

  async getRemoteHandler (remote) {
    if (typeof remote === 'string') {
      remote = await this.getRemote(remote)
    }

    if (!remote.enabled) {
      throw new Error('remote is disabled')
    }

    const { id } = remote
    const handlers = this._handlers
    let handler = handlers[id]
    if (handler === undefined) {
      handler = handlers[id] = getHandler(remote)
    }

    try {
      await handler.sync()
      ignoreErrors.call(this._updateRemote(id, { error: '' }))
    } catch (error) {
      ignoreErrors.call(this._updateRemote(id, { error: error.message }))
      throw error
    }

    return handler
  }

  async testRemote (remote) {
    const handler = await this.getRemoteHandler(remote)
    return handler.test()
  }

  async getAllRemotes () {
    return this._remotes.get()
  }

  async getRemote (id) {
    const remote = await this._remotes.first(id)
    if (remote === undefined) {
      throw noSuchObject(id, 'remote')
    }
    return remote.properties
  }

  async createRemote ({ name, url, options }) {
    const params = {
      name,
      url,
      enabled: false,
      error: '',
    }
    if (options !== undefined) {
      params.options = options
    }
    const remote = await this._remotes.add(params)
    return /* await */ this.updateRemote(remote.get('id'), { enabled: true })
  }

  updateRemote (id, { name, url, options, enabled }) {
    const handlers = this._handlers
    const handler = handlers[id]
    if (handler !== undefined) {
      delete this._handlers[id]
      ignoreErrors.call(handler.forget())
    }

    return this._updateRemote(id, {
      name,
      url,
      options,
      enabled,
    })
  }

  @synchronized()
  async _updateRemote (id, props) {
    const remote = await this.getRemote(id)
    patch(remote, props)
    return (await this._remotes.update(remote)).properties
  }

  async removeRemote (id) {
    const handler = this._handlers[id]
    if (handler !== undefined) {
      ignoreErrors.call(handler.forget())
    }

    await this._remotes.remove(id)
  }
}
