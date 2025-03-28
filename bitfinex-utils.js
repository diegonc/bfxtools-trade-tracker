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

function truthyOrZero(o) {
  return !!o || o === 0
}

exports.onStatusHandlerCreator = function (statusKey, onStatus) {
  const state = {
    fundingValue: {},
    markPriceValue: {},
    currentEventTsValue: {},
  }

  function resetState() {
    state.fundingValue = {}
    state.markPriceValue = {}
    state.currentEventTsValue = {}
  }

  function onStatusHandler(status) {
    const funding = (state.fundingValue[statusKey] = truthyOrZero(
      state.fundingValue[statusKey]
    )
      ? state.fundingValue[statusKey]
      : status[11])
    const markPrice = (state.markPriceValue[statusKey] = status[14])
    const currentEventTs = (state.currentEventTsValue[statusKey] =
      state.currentEventTsValue[statusKey] || status[7])
    const statusTs = status[0]

    if (statusTs < currentEventTs) {
      state.fundingValue[statusKey] = status[11]
      state.markPriceValue[statusKey] = status[14]
    } else {
      const diffTs = Math.abs(currentEventTs - statusTs)
      logger.debug('status after CET %j', {
        statusTs,
        currentEventTs,
        nextTs: status[7],
        markPrice,
        funding,
        diffTs,
      })

      state.fundingValue[statusKey] = status[11]
      state.markPriceValue[statusKey] = status[14]
      state.currentEventTsValue[statusKey] = status[7]

      if (onStatus) {
        try {
          onStatus({
            statusTs,
            currentEventTs,
            nextTs: status[7],
            markPrice,
            funding,
          })
        } catch (err) {
          logger.error(err)
        }
      }
    }
  }
  return { state, resetState, onStatusHandler }
}

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

  const { resetState: resetOnStatusState, onStatusHandler } =
    exports.onStatusHandlerCreator(statusKey, onStatus)
  ws.onStatus({ key: statusKey }, onStatusHandler)

  ws.on('error', (e) => logger.debug(e))
  ws.on('auth', () => logger.debug('auth :: authenticated'))
  ws.on('open', async () => {
    logger.debug('open :: subscribing to channels')

    trades = {}
    resetOnStatusState()
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
