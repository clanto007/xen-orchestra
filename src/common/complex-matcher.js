import every from 'lodash/every'
import isArray from 'lodash/isArray'
import isPlainObject from 'lodash/isPlainObject'
import isString from 'lodash/isString'
import some from 'lodash/some'
import { invoke } from 'utils'

// and = term+
// term = ws* (not | property | string)
// not = "!" term
// property = string ":" term
// string = /[a-z0-9-_.]+/i
export const parse = invoke(() => {
  let i
  let n
  let pattern

  // -----

  const rule = parser => () => {
    const pos = i
    const node = parser()
    if (node) {
      return node
    }
    i = pos
  }

  // -----

  const parseAnd = rule(() => {
    const children = []

    while (i < n) { // eslint-disable-line no-unmodified-loop-condition
      const child = parseTerm()
      if (!child) {
        break
      }
      children.push(child)
    }

    const { length } = children
    if (!length) {
      return
    }
    if (length === 1) {
      return children[0]
    }
    return { type: 'and', children }
  })
  const parseTerm = rule(() => {
    while (i < n && pattern[i] === ' ') {
      ++i
    }

    return parseNot() || parseProperty() || parseString()
  })
  const parseNot = rule(() => {
    let child
    if (
      pattern[i++] === '!' &&
      (child = parseTerm())
    ) {
      return { type: 'not', child }
    }
  })
  const parseProperty = rule(() => {
    let name, child
    if (
      (name = parseString()) &&
      pattern[i++] === ':' &&
      (child = parseTerm())
    ) {
      return { type: 'property', name: name.value, child }
    }
  })
  const parseString = rule(() => {
    const matches = pattern.slice(i).match(/^[a-z0-9-_.]+/i)
    if (!matches) {
      return
    }

    const value = matches[0]
    i += value.length

    return { type: 'string', value }
  })

  return pattern_ => {
    i = 0
    n = pattern_.length
    pattern = pattern_

    try {
      return parseAnd()
    } finally {
      pattern = null
    }
  }
})

export const execute = invoke(() => {
  const visitors = {
    and: ({ children }, value) => (
      every(children, child => execute(child, value))
    ),
    not: ({ child }, value) => (
      !execute(child, value)
    ),
    or: ({ children }, value) => (
      some(children, child => execute(child, value))
    ),
    property: ({ name, child }, value) => (
      value != null && execute(child, value[name])
    ),
    string: invoke(() => {
      const match = (pattern, value) => {
        if (isString(value)) {
          return value.toLowerCase().indexOf(pattern) !== -1
        }

        if (isArray(value) || isPlainObject(value)) {
          return some(value, value => match(pattern, value))
        }

        return false
      }

      return ({ value: pattern }, value) => (
        match(pattern.toLowerCase(), value)
      )
    })
  }

  return (node, value) => visitors[node.type](node, value)
})

export const create = pattern => {
  pattern = parse(pattern)
  if (!pattern) {
    return
  }

  return value => execute(pattern, value)
}
