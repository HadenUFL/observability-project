const telemetry = require('./tracing');
const { performance } = require('node:perf_hooks');
const express = require('express');
const { MongoClient } = require('mongodb');
const { context, metrics, trace, SpanStatusCode } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const app = express();
const port = Number(process.env.PORT ?? 3000);
const client = new MongoClient(
  process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
  { serverSelectionTimeoutMS: 5000 }
);
const todos = client.db('todo').collection('todos');
const tracer = trace.getTracer('todo-service');
const meter = metrics.getMeter('todo-service');
const logger = logs.getLogger('todo-service');

const requestCount = meter.createCounter('todo.http.requests', {
  description: 'Completed HTTP requests',
  unit: '{request}',
});
const requestDuration = meter.createHistogram('todo.http.request.duration', {
  description: 'HTTP request duration',
  unit: 'ms',
});

let server;
let stopping = false;

function emitLog(body, attributes = {}, severityNumber = SeverityNumber.INFO) {
  logger.emit({
    body,
    attributes,
    severityNumber,
    severityText: severityNumber >= SeverityNumber.ERROR ? 'ERROR' : 'INFO',
  });
}

function tracedRoute(name, handler) {
  return (req, res, next) =>
    tracer.startActiveSpan(name, async span => {
      try {
        await handler(req, res, span);
      } catch (error) {
        span.recordException(error);
        span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        next(error);
      } finally {
        span.end();
      }
    });
}

app.use((req, res, next) => {
  const startedAt = performance.now();

  res.once('finish', context.bind(context.active(), () => {
    const duration = performance.now() - startedAt;
    const attributes = {
      'http.request.method': req.method,
      'http.route': req.route?.path ?? 'unmatched',
      'http.response.status_code': res.statusCode,
    };

    requestCount.add(1, attributes);
    requestDuration.record(duration, attributes);
    emitLog('HTTP request completed', {
      ...attributes,
      duration_ms: Number(duration.toFixed(2)),
    });
  }));

  next();
});

app.use(express.json());

app.get('/todo', tracedRoute('todo.list', async (req, res, span) => {
  const results = await todos.find({}).sort({ id: 1 }).toArray();
  span.setAttribute('todo.result_count', results.length);
  res.json(results);
}));

app.get('/todo/:id', tracedRoute('todo.get', async (req, res, span) => {
  span.setAttribute('todo.id', req.params.id);
  const todo = await todos.findOne({ id: req.params.id });
  span.setAttribute('todo.found', Boolean(todo));

  if (!todo) {
    res.status(404).json({ error: 'Todo not found' });
    return;
  }

  res.json(todo);
}));

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((error, req, res, next) => {
  emitLog('Request failed', {
    'error.type': error.name,
    'error.message': error.message,
  }, SeverityNumber.ERROR);

  if (res.headersSent) {
    next(error);
    return;
  }

  const status = Number.isInteger(error.status) && error.status >= 400 && error.status < 500
    ? error.status
    : 500;

  res.status(status).json({
    error: status < 500 ? 'Invalid request' : 'Internal server error',
  });
});

async function startServer() {
  await client.connect();
  await todos.createIndex({ id: 1 }, { unique: true });

  const sampleTodos = [
    { id: '1', title: 'Buy groceries' },
    { id: '2', title: 'Review OpenTelemetry traces' },
    { id: '3', title: 'Inspect MongoDB spans' },
  ];

  await todos.bulkWrite(sampleTodos.map(todo => ({
    updateOne: {
      filter: { id: todo.id },
      update: { $setOnInsert: todo },
      upsert: true,
    },
  })));

  await new Promise((resolve, reject) => {
    server = app.listen(port, '127.0.0.1', resolve);
    server.once('error', reject);
  });

  emitLog(`Server listening at http://localhost:${port}`);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;

  emitLog('Application stopping', { signal });
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();

  try {
    if (server?.listening) {
      await new Promise(resolve => server.close(resolve));
    }
    await client.close();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    try {
      await telemetry.shutdown();
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
    clearTimeout(timeout);
  }
}

process.once('SIGINT', () => { void shutdown('SIGINT'); });
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });

startServer().catch(async error => {
  emitLog('Startup failed', { 'error.message': error.message }, SeverityNumber.ERROR);
  process.exitCode = 1;
  await shutdown('startup_failure');
});