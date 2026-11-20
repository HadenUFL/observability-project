const { NodeSDK } = require('@opentelemetry/sdk-node');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { ATTR_SERVICE_NAME } = require('@opentelemetry/semantic-conventions');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const {
  ConsoleMetricExporter,
  PeriodicExportingMetricReader,
} = require('@opentelemetry/sdk-metrics');
const {
  ConsoleLogRecordExporter,
  SimpleLogRecordProcessor,
} = require('@opentelemetry/sdk-logs');

const enabledInstrumentations = new Set([
  '@opentelemetry/instrumentation-http',
  '@opentelemetry/instrumentation-express',
  '@opentelemetry/instrumentation-mongodb',
]);

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: 'todo-service',
  }),
  traceExporter: new OTLPTraceExporter({
    url: 'http://127.0.0.1:4318/v1/traces',
  }),
  metricReaders: [
    new PeriodicExportingMetricReader({
      exporter: new ConsoleMetricExporter(),
      exportIntervalMillis: 10000,
    }),
  ],
  logRecordProcessors: [
    new SimpleLogRecordProcessor({
      exporter: new ConsoleLogRecordExporter(),
    }),
  ],
  instrumentations: getNodeAutoInstrumentations().filter(
    instrumentation => enabledInstrumentations.has(instrumentation.instrumentationName)
  ),
});

sdk.start();

module.exports = sdk;