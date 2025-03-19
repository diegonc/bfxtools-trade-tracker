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

  let trades = {}
  ws.onAccountTradeEntry({ symbol }, (trade) => {
    console.log('trade entry', JSON.stringify(trade, null, 2))
    const tradeId = trade[0]
    trades[tradeId] = trade
  })
  ws.onAccountTradeUpdate({ symbol }, (trade) => {
    console.log('trade update', JSON.stringify(trade, null, 2))
    const tradeId = trade[0]
    const teData = trades[tradeId]
    if (!!teData) {
      delete trades[tradeId]
      if (onTrade)
        onTrade({
          id: tradeId,
          symbol: trade[1],
          mts: trade[2],
          orderId: trade[3],
          execAmount: trade[4],
          execPrice: trade[5],
          orderType: trade[6],
          orderPrice: trade[7],
          maker: trade[8] === 1,
          fee: trade[9],
          feeCurrency: trade[10],
          clientOrderId: trade[11],
        })
    }
  })

  let tsState = {}
  let lastTs = {}
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

    trades = {}
    tsState = {}
    lastTs = {}
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
