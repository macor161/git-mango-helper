var async = require('async')
var pull = require('pull-stream')
var multicb = require('multicb')
var crypto = require('crypto')
var Web3 = require('web3')
var rlp = require('rlp')
var ethUtil = require('ethereumjs-util')
var snapshot = require('./snapshot.js')
var repoABI = require('./MangoRepoABI.json')
var ipfsAPI = require('ipfs-api')

var ipfs = ipfsAPI('localhost', '5002', {protocol: 'http'}) 

// from https://github.com/clehner/memory-pull-git-repo
function gitHash (obj, data) {
  var hasher = crypto.createHash('sha1')
  hasher.update(obj.type + ' ' + obj.length + '\0')
  hasher.update(data)
  return hasher.digest('hex')
}

// FIXME: move into context?
function ipfsPut (buf, enc, cb) {
  //console.error('-- IPFS PUT')
  ipfs.object.put({ Data: buf.toString('base64'), Links: [] }, function (err, node) {
    if (err) {
      return cb(err)
    }

    cb(null, node.toJSON().multihash)
  })
}

// FIXME: move into context?
function ipfsGet (key, cb) {
  //console.error('-- IPFS GET ', key)
  ipfs.object.get(key, function (err, node) {
    if (err) {
      return cb(err)
    }
    cb(null, Buffer.from(node.toJSON().data.toString(), 'base64'))
  })
}

module.exports = Repo

function Repo (address, user) {

  this.web3 = new Web3(new Web3.providers.HttpProvider(process.env['ETHEREUM_RPC_URL'] || 'http://localhost:8545'))
  try {
    this.web3.eth.defaultAccount = user || this.web3.eth.coinbase
  } catch (e) {
  }

  this.repoContract = this.web3.eth.contract(repoABI).at(address)
}

Repo.prototype._loadObjectMap = function (cb) {
  var self = this
  self._objectMap = {}
  self.snapshotGetAll(function (err, res) {
    if (err) return cb(err)

    async.each(res, function (item, cb) {
      ipfsGet(item, function (err, data) {
        if (err) return cb(err)
        Object.assign(self._objectMap, snapshot.parse(data))
        cb()
      })
    }, function (err) {
      cb(err)
    })
  })
}

Repo.prototype._ensureObjectMap = function (cb) {
  if (this._objectMap === undefined) {
    this._loadObjectMap(cb)
  } else {
    cb()
  }
}

Repo.prototype.snapshotAdd = function (hash, cb) {
  this.repoContract.addSnapshot(hash, cb, { gas: 500000 })
}

Repo.prototype.snapshotGetAll = function (cb) {
  var count = this.repoContract.snapshotCount().toNumber()
  var snapshots = []

  for (var i = 0; i < count; i++) {
    snapshots.push(this.repoContract.getSnapshot(i))
  }

  cb(null, snapshots)
}

Repo.prototype.contractGetRef = function (ref, cb) {
  // console.error('REF GET', ref)
  this.repoContract.getRef(ref, cb)
}

Repo.prototype.contractSetRef = function (ref, hash, cb) {
  // console.error('REF SET', ref, hash)
  this.repoContract.setRef(ref, hash, cb, { gas: 500000 })
}

// FIXME: should be fully asynchronous
Repo.prototype.contractAllRefs = function (cb) {
  var refcount = this.repoContract.refCount().toNumber()
  // console.error('REFCOUNT', refcount)

  var refs = {}
  for (var i = 0; i < refcount; i++) {
    var key = this.repoContract.refName(i)
    refs[key] = this.repoContract.getRef(key)
    // console.error('REF GET', i, key, refs[key])
  }

  cb(null, refs)
}

Repo.prototype.refs = function (prefix) {
  var refcount = this.repoContract.refCount().toNumber()
  // console.error('REFCOUNT', refcount)

  var refs = {}
  for (var i = 0; i < refcount; i++) {
    var key = this.repoContract.refName(i)
    refs[key] = this.repoContract.getRef(key)
    // console.error('REF GET', i, key, refs[key])
  }

  var refNames = Object.keys(refs)
  i = 0
  return function (abort, cb) {
    if (abort) return
    if (i >= refNames.length) return cb(true)
    var refName = refNames[i++]
    cb(null, {
      name: refName,
      hash: refs[refName]
    })
  }
}

// FIXME: this is hardcoded for HEAD -> master
Repo.prototype.symrefs = function (a) {
  var i = 0
  return function (abort, cb) {
    if (abort) return
    if (i > 0) return cb(true)
    i++
    cb(null, {
      name: 'HEAD',
      ref: 'refs/heads/master'
    })
  }
}

Repo.prototype.hasObject = function (hash, cb) {
  var self = this

  // console.error('HAS OBJ', hash)

  this._ensureObjectMap(function () {
    // console.error('HAS OBJ', hash in self._objectMap)
    cb(null, hash in self._objectMap)
  })
}

Repo.prototype.getObject = function (hash, cb) {
  var self = this

  // console.error('GET OBJ', hash)

  this._ensureObjectMap(function (err) {
    if (err) return cb(err)

    if (!self._objectMap[hash]) {
      return cb('Object not present with key ' + hash)
    }

    ipfsGet(self._objectMap[hash], function (err, data) {
      if (err) return cb(err)

      var res = rlp.decode(data)

      return cb(null, {
        type: res[0].toString(),
        length: parseInt(res[1].toString(), 10),
        read: pull.once(res[2])
      })
    })
  })
}

Repo.prototype.update = function (readRefUpdates, readObjects, cb) {
  // console.error('UPDATE')

  var done = multicb({pluck: 1})
  var self = this

  if (readObjects) {
    var doneReadingObjects = function () {
      ipfsPut(snapshot.create(self._objectMap), null, function (err, ipfsHash) {
        if (err) {
          return done(err)
        }

        self.snapshotAdd(ipfsHash, function () {
          done()
        })
      })
    }

    // FIXME
    self._objectMap = self._objectMap || {}

    readObjects(null, function next (end, object) {
      if (end) {
        return doneReadingObjects(end === true ? null : end)
      }

      pull(
        object.read,
        pull.collect(function (err, bufs) {
          if (err) {
            return doneReadingObjects(err)
          }

          var buf = Buffer.concat(bufs)
          var hash = gitHash(object, buf)

          // console.error('UPDATE OBJ', hash, object.type, object.length)

          var data = rlp.encode([ ethUtil.toBuffer(object.type), ethUtil.toBuffer(object.length.toString()), buf ])

          ipfsPut(data, null, function (err, ipfsHash) {
            if (err) {
              return doneReadingObjects(err)
            }

            self._objectMap[hash] = ipfsHash
            readObjects(null, next)
          })
        })
      )
    })
  }

  if (readRefUpdates) {
    var doneReadingRefs = done()

    readRefUpdates(null, function next (end, update) {
      if (end) {
        return doneReadingRefs(end === true ? null : end)
      }

      // console.error('UPDATE REF', update.name, update.new, update.old)

      // FIXME: make this async
      var ref = self.repoContract.getRef(update.name)
      if (typeof(ref) === 'string' && ref.length === 0) {
        ref = null
      }

      if (update.old !== ref) {
        return doneReadingRefs(new Error(
          'Ref update old value is incorrect. ' +
          'ref: ' + update.name + ', ' +
          'old in update: ' + update.old + ', ' +
          'old in repo: ' + ref
        ))
      }

      if (update.new) {
        // FIXME: make this async
        self.repoContract.setRef(update.name, update.new, { gas: 5000000 })
      } else {
        // FIXME: make this async
        self.repoContract.deleteRef(update.name, { gas: 500000 })
      }

      readRefUpdates(null, next)
    })
  }

  done(function (err) {
    if (err) {
      return cb(err)
    }
    cb()
  })
}
