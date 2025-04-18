import winston from 'winston'
const { createLogger, format, transports } = winston

function trimString(n, s) {
  return s.padStart(n).slice(-n)
}

const trimLevel = format((info, opts) => {
  return { ...info, level: trimString(6, info.level) }
})

const loggers = {}

export default function getLogger(name) {
  if (loggers[name]) {
    return loggers[name]
  }

  return (loggers[name] = createLogger({
    level: 'silly',
    format: format.combine(
      format.errors({ stack: true }),
      format.label({ label: trimString(8, name) }),
      format.timestamp(),
      trimLevel(),
      format.splat(),
      format.colorize(),
      format.printf(
        ({ timestamp, level, label, message, stack }) =>
          `${timestamp} ${level} [${label}] ${message} ${stack || ''}`
      )
    ),
    transports: new transports.Console(),
  }))
}
