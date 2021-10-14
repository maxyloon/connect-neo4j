module.exports = function (session) {
    const Store = session.Store

    const noop = () => {}
  
    class Neo4jStore extends Store {
      constructor(options = {}) {
        super(options)
        if (!options.client) {
          throw new Error('A session must be directly provided to the Neo4jStore')
        }
  
        this.prefix = options.prefix == null ? 'sess:' : options.prefix
        this.scanCount = Number(options.scanCount) || 100
        this.serializer = options.serializer || JSON 
        this.client = options.client
        this.nodeLabel = options.nodeLabel || 'Session'
        this.ttl = options.ttl || 86400 // One day in seconds.
        this.disableTTL = options.disableTTL || false
        this.disableTouch = options.disableTouch || false
       
      }

      get(sid, cb = noop) {
        let key = this.prefix + sid
        this.client.run(`MATCH (s:${this.nodeLabel} {sid: $sid}) RETURN s`, { sid: key, })
          .then(result => {
            if (result.records.length === 0) {
              return cb(null, null)
            }
  
            let record = result.records[0]
            let session = record.get('s')
  
            let data = session.properties.data
            let expires = session.properties.expires

            if (this.disableTTL) {
              expires = null
            }
  
            if (this.disableTouch) {
              expires = null
            }
  
            if (expires && expires < Date.now()) {
              this.destroy(sid, noop)
              return cb(null, null)
            }
            cb(null, this.serializer.parse(data))
          })
          .catch(cb)
      }
    
    set(sid, session, cb = noop) {
      let key = this.prefix + sid
      let data = this.serializer.stringify(session)
      let expires = null
  
      if (!this.disableTTL) {
        expires = Date.now() + this._getTTL(session)
      }
  
      this.client.run(`MERGE (s:${this.nodeLabel} {sid: $sid}) ON CREATE SET s.data = $data, s.expires = $expires ON MATCH SET s.data = $data`, { sid: key, data, expires })
        .then(() => cb(null, "OK"))
        .catch(cb)
    }
    touch(sid, session, cb = noop) {
    if (this.disableTouch || this.disableTTL) return cb()
      let key = this.prefix + sid  
      if (!this.disableTTL) {
        expires = this._getTTL(session)
      }
      this.client.run(`MATCH (s:${this.nodeLabel} {sid: $sid}) SET s.expires = $expires`, { sid: key, expires })

    }
    destroy(sid, cb = noop) {
      let key = this.prefix + sid
      this.client.run(`MATCH (s:${this.nodeLabel} {sid: $sid}) DELETE s`, { sid: key }).
      then(() => cb(null, true))
      .catch(cb)
    }
    clear(cb = noop) {
      this.client.run(`MATCH (s:${this.nodeLabel}) DETACH DELETE s`)
        .then(() => cb(null, true))
        .catch(cb)
    }
    length(cb = noop) {
      this._getAllKeys((err, keys) => {
        if (err) return cb(err)
        cb(null, keys.length)
      })
    }
    ids(cb = noop) {
      this._getAllKeys((err, keys) => {
        if (err) return cb(err)
        cb(null, keys)
      })
    }
    all(cb = noop) {
      this._getAllKeys((err, keys) => {
        if (err) return cb(err)
        let sessions = {}
        let count = 0
        let done = () => cb(null, sessions)
        let next = () => {
          if (count === keys.length) return done()
          this.get(keys[count], (err, sess) => {
            if (err) return cb(err)
            sessions[keys[count]] = sess
            count++
            next()
          })
        }
        next()
      })
    }
    _getTTL(sess) {
        let ttl
        if (sess && sess.cookie && sess.cookie.expires) {
          let ms = Number(new Date(sess.cookie.expires)) - Date.now()
          ttl = Math.ceil(ms / 1000)
        } else {
          ttl = this.ttl
        }
        return ttl
      }
    _getAllKeys(cb = noop) {
      this.client.run(`MATCH (s:${this.nodeLabel}) RETURN s.sid`)
        .then(result => {
          let keys = result.records.map(record => record.get('s.sid'))
          cb(null, keys)
        })
        .catch(cb)
    }
}
return Neo4jStore
}