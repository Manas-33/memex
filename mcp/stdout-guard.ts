// The stdio transport carries MCP messages on stdout, so anything else printed there
// corrupts the stream. The shared retrieval code logs with console.log; send all of it
// to stderr. Imported first so it's in place before anything can log.
console.log = console.info = console.warn = console.debug = (...args: unknown[]) => console.error(...args);

export {};
