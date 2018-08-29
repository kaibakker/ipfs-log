'use strict'

class AccessController {
  constructor () {}

  async canAppend(entry, identityProvider) {
    return true
  }
}

module.exports = AccessController
