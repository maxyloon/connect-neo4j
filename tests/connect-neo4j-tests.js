const test = require('tape')
const session = require('express-session')
const neo4j = require('neo4j-driver')
const uri = process.env.NEO4J_URI || 'bolt://localhost:7687'
const user = process.env.NEO4J_USER || 'neo4j'
const password = process.env.NEO4J_PASSWORD || 'neo4j'
const driver = neo4j.driver(uri, neo4j.auth.basic(user, password))

let Neo4jStore = require('../lib/connect-neo4j')(session)

let p =
  (ctx, method) =>
  (...args) =>
    new Promise((resolve, reject) => {
      ctx[method](...args, (err, d) => {
        if (err) reject(err)
        resolve(d)
      })
    })
test('setup', async (t) => {
  var client = driver.session()
  var store = new Neo4jStore({ client })
  let res = await p(store, 'clear')()
  t.ok((res = true), 'clear sessions')
})

test('defaults', async (t) => {
  t.throws(() => new Neo4jStore(), 'client is required')
  var client = driver.session()
  var store = new Neo4jStore({ client })
  t.equal(store.client, client, 'stores client')
  t.equal(store.prefix, 'sess:', 'defaults to sess:')
  t.equal(store._ttl, 86400, 'defaults to one day')
  t.equal(store.serializer, JSON, 'defaults to JSON serialization')
  t.equal(store.disableTouch, false, 'defaults to having `touch` enabled')
  t.equal(store.disableTTL, false, 'defaults to having `ttl` enabled')
})

test('node_neo4j', async (t) => {
  t.plan(20)
  var client = driver.session()
  var store = new Neo4jStore({ client })
  await lifecycleTest(store, t)
  client.close()

  t.end()
})

test.onFinish(() => {
  driver.close()
  process.exit(0)
})
async function lifecycleTest(store, t) {
  let res = await p(store, 'set')('123', { foo: 'bar' })
  t.equal(res, 'OK', 'set value')

  res = await p(store, 'get')('123')
  t.same(res, { foo: 'bar' }, 'get value')

  res = await p(store, 'ttl')('123')
  t.ok(res >= 86300 && res < 86400, 'check one day ttl')

  let ttl = 60
  let expires = new Date(Date.now() + ttl * 1000).toISOString()
  res = await p(store, 'set')('456', { cookie: { expires } })
  t.equal(res, 'OK', 'set cookie expires')

  res = await p(store, 'ttl')('456')
  t.ok(res <= 60, 'check expires ttl')

  ttl = 90
  let newExpires = new Date(Date.now() + ttl * 1000).toISOString()
  res = await p(store, 'touch')('456', { cookie: { expires: newExpires } })
  t.equal(res, 'OK', 'set cookie expires touch')

  res = await p(store, 'ttl')('456')
  t.ok(res > 60, 'check expires ttl touch')

  res = await p(store, 'length')()
  t.equal(res, 2, 'stored two keys length')

  res = await p(store, 'ids')()
  res.sort()
  t.same(res, ['123', '456'], 'stored two keys ids')

  res = await p(store, 'all')()
  res.sort((a, b) => (a.id > b.id ? 1 : -1))
  t.same(
    res,
    [
      { id: '123', foo: 'bar' },
      { id: '456', cookie: { expires } },
    ],
    'stored two keys data'
  )

  res = await p(store, 'destroy')('456')
  t.equal(res, 1, 'destroyed one')

  res = await p(store, 'length')()
  t.equal(res, 1, 'one key remains')

  res = await p(store, 'clear')()
  t.equal(res, 1, 'cleared remaining key')

  res = await p(store, 'length')()
  t.equal(res, 0, 'no key remains')

  let count = 1000
  await load(store, count)

  res = await p(store, 'length')()
  t.equal(res, count, 'bulk count')

  res = await p(store, 'clear')()
  t.equal(res, count, 'bulk clear')

  expires = new Date(Date.now() + ttl * 1000).toISOString() // expires in the future
  res = await p(store, 'set')('789', { cookie: { expires } })
  t.equal(res, 'OK', 'set value')

  res = await p(store, 'length')()
  t.equal(res, 1, 'one key exists (session 789)')

  expires = new Date(Date.now() - ttl * 1000).toISOString() // expires in the past
  res = await p(store, 'set')('789', { cookie: { expires } })
  t.equal(res, 1, 'returns 1 because destroy was invoked')

  res = await p(store, 'length')()
  t.equal(res, 0, 'no key remains and that includes session 789')
  return
}

function load(store, count) {
  return new Promise((resolve, reject) => {
    let set = (sid) => {
      store.set(
        's' + sid,
        {
          cookie: { expires: new Date(Date.now() + 1000) },
          data: 'some data',
        },
        (err) => {
          if (err) {
            return reject(err)
          }

          if (sid === count) {
            return resolve()
          }

          set(sid + 1)
        }
      )
    }
    set(1)
  })
}
