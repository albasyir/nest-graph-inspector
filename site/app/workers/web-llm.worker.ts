/**
 * The thread the chat model actually runs on.
 *
 * Token decoding is a tight loop that owns a WebGPU device, and running it on
 * the main thread freezes the viewer — the graph stops panning while the model
 * answers. web-llm's `WebWorkerMLCEngineHandler` is the whole backend; the
 * engine the panel holds is a thin client that talks to this file over
 * `postMessage`, so there is nothing else to write here.
 *
 * Started by `useWebLlmEngine` via `new Worker(new URL(...), { type: 'module' })`
 * so Vite emits it as its own chunk and rewrites the URL for the site's
 * GitHub Pages base path.
 */
import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

const handler = new WebWorkerMLCEngineHandler()

self.onmessage = (event: MessageEvent) => {
  handler.onmessage(event)
}
