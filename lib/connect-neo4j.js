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
      this.serializer = options.serializer || JSON
      this.client = options.client
      this.nodeLabel = options.nodeLabel || 'Session'
      this._ttl = options.ttl || 86400 // One day in seconds.
      this.disableTTL = options.disableTTL || false
      this.disableTouch = options.disableTouch || false
      if(options.user){
        this.userLabel = options.user.label == null ? '' : options.user.label
        if(!options.user.id){
          throw new Error('A user object is present, but no identifying property is supplied');
        }
        this.userId = options.user.id
        this.userRelType = options.user.relType == null ? '' : ':' + options.user.relType
      }
    }

    get(sid, cb = noop) {
      let key = this.prefix + sid
      let sess = this.client.session()
      sess
        .run(`MATCH (s:${this.nodeLabel} {sid: $sid}) RETURN s`, { sid: key })
        .then((result) => {
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
        .finally(() => sess.close())
    }

    set(sid, session, cb = noop) {
      let key = this.prefix + sid
      let data = this.serializer.stringify(session)
      let expires = null

      if (!this.disableTTL) {
        const ttl = this._getTTL(session)
        if (ttl <= 0) {
          this.destroy(sid, (err, res) => cb(err, res))
          return
        } else {
          expires = Date.now() + ttl
        }
      }

      let sess = this.client.session()
      sess.run(`MERGE (s:${this.nodeLabel} {sid: $sid}) 
        ON CREATE SET s.data = $data, s.expires = $expires 
        ON MATCH SET s.data = $data`,  
        { sid: key, data, expires }
      ).then(async () => {
        if(this.userLabel && session[this.userId]){
          let opts = {sid: key};
          opts[this.userId] = session[this.userId];
          await sess.run(`MATCH (s:${this.nodeLabel}{sid:$sid})
          OPTIONAL MATCH (n:${this.userLabel}{${this.userId}:$${this.userId}})
          MERGE (s)<-[${this.userRelType}]-(n)`,
          opts);
        }
      }).then(() => {cb(null, 'OK')})
      .catch(cb)
      .finally(() => {sess.close()});
    }
    touch(sid, session, cb = noop) {
      if (this.disableTouch || this.disableTTL) return cb(null, null)
      let key = this.prefix + sid
      let expires
      if (!this.disableTTL) {
        expires = Date.now() + this._getTTL(session)
      }
      let sess = this.client.session()
      sess
        .run(
          `MATCH (s:${this.nodeLabel} {sid: $sid}) SET s.expires = $expires`,
          { sid: key, expires }
        )
        .then((res) => {
          cb(null, 'OK')
        })
        .catch(cb)
        .finally(() => sess.close())
    }
    destroy(sid, cb = noop) {
      let key = this.prefix + sid
      let sess = this.client.session()
      sess
        .run(
          `MATCH (s:${this.nodeLabel} {sid: $sid}) WHERE s.sid STARTS WITH $prefix DETACH DELETE s`,
          { sid: key, prefix: this.prefix }
        )
        .then(() => cb(null, 1))
        .catch(cb)
        .finally(() => sess.close())
    }
    clear(cb = noop) {
      let sess = this.client.session()
      sess
        .run(
          `MATCH (s:${this.nodeLabel}) WHERE s.sid STARTS WITH $prefix DETACH DELETE s`,
          { prefix: this.prefix }
        )
        .then((res) => cb(null, res.summary.counters.updates().nodesDeleted))
        .catch(cb)
        .finally(() => sess.close())
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
        cb(
          null,
          keys.map((key) => key.replace(this.prefix, ''))
        )
      })
    }
    all(cb = noop) {
      let sess = this.client.session()
      sess
        .run(
          `MATCH (s:${this.nodeLabel}) WHERE s.sid STARTS WITH $prefix RETURN s`,
          { prefix: this.prefix }
        )
        .then((result) => {
          let records = result.records.map((record) => record.get('s'))
          let sessions = records.map((record) => {
            const id = { id: record.properties.sid.replace(this.prefix, '') }
            const data = this.serializer.parse(record.properties.data)
            return {
              ...id,
              ...data,
            }
          })
          cb(null, sessions)
        })
        .catch(cb)
        .finally(() => sess.close())
    }

    ttl(sid, cb = noop) {
      let key = this.prefix + sid
      let sess = this.client.session()
      sess
        .run(`MATCH (s:${this.nodeLabel} {sid: $sid}) RETURN s.expires`, {
          sid: key,
        })
        .then((result) => {
          if (result.records.length === 0) {
            return cb(null, null)
          }
          let expires = result.records[0].get('s.expires')
          if (this.disableTTL) {
            expires = null
          }

          if (expires) {
            expires = new Date(expires)
            expires = expires.getTime() - Date.now()
            return cb(null, expires)
          } else {
            return cb(null, null)
          }
        })
        .catch(cb)
        .finally(() => sess.close())
    }

    _getTTL(sess) {
      let ttl
      if (sess && sess.cookie && sess.cookie.expires) {
        let ms = Number(new Date(sess.cookie.expires)) - Date.now()
        ttl = Math.ceil(ms / 1000)
      } else {
        ttl = this._ttl
      }
      return ttl
    }
    _getAllKeys(cb = noop) {
      let sess = this.client.session()
      sess
        .run(`MATCH (s:${this.nodeLabel}) RETURN s.sid`)
        .then((result) => {
          let keys = result.records.map((record) => record.get('s.sid'))
          cb(null, keys)
        })
        .catch(cb)
        .finally(() => sess.close())
    }
  }
  return Neo4jStore
}
