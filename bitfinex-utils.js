const BFX = require('bitfinex-api-node')
const dayjs = require('dayjs')
const createLogger = require('./logging')

const logger = createLogger('bfx')

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
    logger.debug('trade entry', trade)
    const tradeId = trade[0]
    trades[tradeId] = trade
  })
  ws.onAccountTradeUpdate({ symbol }, (trade) => {
    logger.debug('trade update', trade)
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

  let fundingValue = {}
  let markPriceValue = {}
  let nextTsValue = {}
  ws.onStatus({ key: statusKey }, (status) => {
    const funding = (fundingValue[statusKey] =
      fundingValue[statusKey] || status[11])
    const markPrice = (markPriceValue[statusKey] = status[14])
    const nextTs = (nextTsValue[statusKey] =
      nextTsValue[statusKey] || status[7])
    const ts = status[0]

    if (nextTs - ts < 500) {
      logger.debug('status %j', { ts, nextTs, markPrice, funding })
      if (onStatus) {
        onStatus({ ts, markPrice, funding })
      }
      fundingValue[statusKey] = status[11]
      markPriceValue[statusKey] = status[14]
      nextTsValue[statusKey] = status[7]
    }
  })

  ws.on('error', (e) => logger.debug(e))
  ws.on('auth', () => logger.debug('auth :: authenticated'))
  ws.on('open', async () => {
    logger.debug('open :: subscribing to channels')

    trades = {}
    tsState = {}
    lastTs = {}
    try {
      logger.debug('open :: subscribing trades on %s', symbol)
      await ws.subscribeTrades(symbol)
      logger.debug('open :: subscribed trades on %s', symbol)
      logger.debug('open :: subscribing status on %s', statusKey)
      await ws.subscribeStatus(statusKey)
      logger.debug('open :: subscribed status on %s', statusKey)
    } catch (err) {
      logger.error('open :: error', err)
    }
  })

  logger.debug('subscribeTrades :: opening websocket')
  await ws.open()
  logger.debug('subscribeTrades :: opened websocket, authenticating')
  await ws.auth()
  logger.debug('subscribeTrades :: websocket authenticated')
  return { close: () => ws.close() }
}

exports.subscribeTrades = subscribeTrades
