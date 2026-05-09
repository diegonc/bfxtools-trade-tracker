import express from 'express'
import path from 'node:path'

const target = ['..', 'btt-dashboard', 'dist']

function apiV1({ ws, queue }) {
  const router = express.Router()

  router.get('/health-check', (req, res) => {
    return res.json({ status: 'ok' })
  })

  router.get('/queue/stats', (req, res) => {
    res.json({
      isPaused: queue.isPaused,
      isSaturated: queue.isSaturated,
      pending: queue.pending,
      waiting: queue.size,
      concurrency: queue.concurrency,
    })
  })

  router.get('/queue/events', (req, res) => {
    // Set up Server-Sent Events headers
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('Access-Control-Allow-Origin', '*')

    // Send initial connection confirmation
    res.write('data: {"type":"connected"}\n\n')

    // Create event handlers
    const handlers = {
      active: () => {
        res.write(
          `data: ${JSON.stringify({ type: 'active', message: `Size: ${queue.size} Pending: ${queue.pending}` })}\n\n`
        )
      },
      add: (event) => {
        res.write(`data: ${JSON.stringify({ type: 'add', ...event })}\n\n`)
      },
      next: () => {
        res.write(`data: ${JSON.stringify({ type: 'next' })}\n\n`)
      },
      completed: () => {
        res.write(`data: ${JSON.stringify({ type: 'completed' })}\n\n`)
      },
      error: (error) => {
        res.write(
          `data: ${JSON.stringify({ type: 'error', message: error?.message || String(error) })}\n\n`
        )
      },
      idle: () => {
        res.write(`data: ${JSON.stringify({ type: 'idle' })}\n\n`)
      },
    }

    // Register event listeners
    Object.entries(handlers).forEach(([event, handler]) => {
      queue.on(event, handler)
    })

    // Clean up on client disconnect
    req.on('close', () => {
      Object.entries(handlers).forEach(([event, handler]) => {
        queue.off(event, handler)
      })
      res.end()
    })
  })

  return router
}

export function setupDashboard({ host = 'localhost', port = 8000, ws, queue }) {
  const app = express()
  app.use('/api/v1', apiV1({ ws, queue }))
  app.use(express.static(path.join(import.meta.dirname, ...target)))
  return app.listen(port, host)
}
