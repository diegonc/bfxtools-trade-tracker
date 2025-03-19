const BFX = require('bitfinex-api-node')
const dayjs = require('dayjs')

const apiKey = process.env.BITFINEX_API_KEY
const apiSecret = process.env.BITFINEX_API_KEY_SECRET
const bfx = new BFX({ apiKey, apiSecret })

async function getWallets() {
  const rest = bfx.rest()
  return await rest.wallets()
}

exports.getWallets = getWallets

async function ledgers(params) {
  const rest = bfx.rest()
  return await rest.ledgers(params)
}

exports.ledgers = ledgers

async function subscribeTrades({ symbol, statusKey }, onTrade, onStatus) {
    const ws = bfx.ws(2, { autoReconnect: true })

  ws.onAccountTradeEntry({ symbol }, (trade) => {
    console.log('trade entry', JSON.stringify(trade, null, 2))
    const [chanId, type, data] = trade
    if (type === 'te') {
      const tradeId = data[0]
      trades[tradeId] = data
    } else if (type === 'tu') {
      const tradeId = data[0]
      const teData = trades[tradeId]
      if (!!teData) {
        delete trades[tradeId]
        if (onTrade)
          onTrade({
            id: tradeId,
            symbol: data[1],
            mts: data[2],
            orderId: data[3],
            execAmount: data[4],
            execPrice: data[5],
            orderType: data[6],
            orderPrice: data[7],
            maker: data[8] === 1,
            fee: data[9],
            feeCurrency: data[10],
            clientOrderId: data[11],
          })
      }
    }
  })

  ws.onAccountTradeUpdate({ symbol }, (trade) => {
    console.log('trade update', JSON.stringify(trade, null, 2))
  })

  ws.onStatus({ key: statusKey }, (status) => {
    const currentTs = (tsState[statusKey] = tsState[statusKey] || status[7])
    const ts = status[0]
    if (ts >= currentTs && (!lastTs[statusKey] || lastTs[statusKey] !== ts)) {
      console.log('status', JSON.stringify({ currentTs, ts, status }))
      const nextTs = status[7]
      const funding = status[11]
      lastTs[statusKey] = ts
      tsState[statusKey] = nextTs
      if (onStatus) {
        onStatus({ ts, nextTs, funding })
      }
    }
  })


  ws.on('error', (e) => console.log('subscribeTrades :: error', e))
  ws.on('auth', () => console.log('on auth :: authenticated'))
  ws.on('open', async () => {
    console.log('on open :: subscribing to channels')
    try {
      console.log('on open :: subscribing trades on', symbol)
      await ws.subscribeTrades(symbol)
      console.log('on open :: subscribed trades on', symbol)
      console.log('on open :: subscribing status on', statusKey)
      await ws.subscribeStatus(statusKey)
      console.log('on open :: subscribed status on', statusKey)
    } catch (err) {
      console.log('on open :: error', err)
    }
  })

  console.log('subscribeTrades :: opening websocket')
  await ws.open()
  console.log('subscribeTrades :: opened websocket, authenticating')
  await ws.auth()
  console.log('subscribeTrades :: websocket authenticated')
  return { close: () => ws.close() }
}

exports.subscribeTrades = subscribeTrades
