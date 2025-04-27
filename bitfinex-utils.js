import BFX from 'bitfinex-api-node'
import fs from 'fs'

import createLogger from './logging.js'

const STATUS_LOG_SIZE = 50

const logger = createLogger('bfx')

const apiKey = process.env.BITFINEX_API_KEY
const apiSecret = process.env.BITFINEX_API_KEY_SECRET
const bfx = new BFX({ apiKey, apiSecret })

export async function getWallets() {
  const rest = bfx.rest()
  return await rest.wallets()
}

export async function ledgers(params) {
  const rest = bfx.rest()
  return await rest.ledgers(params)
}

export function onStatusHandlerCreator(statusKey, onStatus) {
  const state = {
    statusLog: [],
    currentEventTsValue: {},
    logEventTsValue: {},
  }

  function resetState() {
    state.statusLog = []
    state.currentEventTsValue = {}
    state.logEventTsValue = {}
  }

  function onStatusHandler(status) {
    const currentEventTs = (state.currentEventTsValue[statusKey] =
      state.currentEventTsValue[statusKey] || status[7])
    const logEventTs = (state.logEventTsValue[statusKey] =
      state.logEventTsValue[statusKey] || status[7])
    const statusTs = status[0]

    state.statusLog = state.statusLog.concat([{
      ts: status[0],
      currentTs: currentEventTs,
      nextTs: status[7],
      markPrice: status[14],
      funding: status[11],
    }]).slice(-STATUS_LOG_SIZE)

    if ((status[0] - logEventTs) > 15000) {
      state.statusLog.forEach((log, index) => {
        logger.silly("log [%d] ts=%d currentTs=%d nextTs=%d funding=%f markPrice=%f",
          index, log.ts, log.currentTs, log.nextTs, log.funding, log.markPrice)
      })
      state.statusLog = []
      state.logEventTsValue[statusKey] = status[7]
    }


    if (currentEventTs != status[7]) {
      const diffTs = (-currentEventTs + statusTs)
      logger.debug(
        'status [next event ts changed diffTs=%d] eventTs=%d, nextTs=%d, markPrice=%f, funding=%f',
        diffTs,
        status[0],
        status[7],
        status[14],
        status[11]
      )

      state.currentEventTsValue[statusKey] = status[7]

      if (onStatus) {
        try {
          onStatus({
            statusTs,
            currentEventTs,
            nextTs: status[7],
            markPrice: status[14],
            funding: status[11],
          })
        } catch (err) {
          logger.error(err)
        }
      }
    }
  }
  return { state, resetState, onStatusHandler }
}

const logFromTs = new Date(2025, 3, 28, 0, 0, 0, 0).getTime()
const logToTs = new Date(2025, 3, 29, 0, 0, 0, 0).getTime()
const logFile = "./status-log.txt"

export async function subscribeTrades(
  { symbol, statusKey },
  onTrade,
  onStatus
) {
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
    onStatusHandlerCreator(statusKey, onStatus)
  ws.onStatus({ key: statusKey }, onStatusHandler)

  /* Log a whole day to replay later for testing */
  ws.onStatus({ key: statusKey }, (status) => {
    if (status[0] >= logFromTs && status[0] <= logToTs) {
      fs.writeFileSync(logFile, JSON.stringify(status) + '\n', { flag: 'a' })
    }
  })

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

export async function getBalance(type, currency) {
  const entries = (await ledgers({ filters: { ccy: currency } }))
    .filter((l) => l[2] === type && l[1] === currency)
    .sort((a, b) => b[3] - a[3] || b[0] - a[0])

  if (entries.length > 0) {
    return entries[0][6]
  } else {
    /* Fallback to balance info (imprecise) */
    const wallets = await getWallets().filter(
      (wallet) =>
        wallet.type.toLowerCase() === walletType.toLowerCase() &&
        wallet.currency.toLowerCase() === walletCurrency.toLowerCase()
    )
    if (wallets.length > 1) {
      throw new Error('[INFO] getBalance - duplicated (type, currency) pair')
    }
    return wallets[0][2]
  }
}
