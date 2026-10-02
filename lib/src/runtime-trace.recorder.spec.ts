import { RuntimeTraceRecorder } from './runtime-trace.recorder';

describe(RuntimeTraceRecorder.name, () => {
  it('retains the 100 most recently completed traces in insertion order', async () => {
    const recorder = new RuntimeTraceRecorder();
    const handles = [];

    for (let index = 0; index < 101; index += 1) {
      const handle = recorder.start({
        moduleName: 'AppModule',
        providerName: 'PingProvider',
        methodName: `ping${index}`,
        args: [],
      });
      handles.push(handle);
      await recorder.finishSuccess(handle, index);
    }

    const completed = recorder.getCompletedTraces();

    expect(completed).toHaveLength(100);
    expect(recorder.getCompletedTrace(handles[0]!.traceId)).toBeUndefined();
    expect(completed.map((trace) => trace.traceId)).toEqual(
      handles.slice(1).map((handle) => handle.traceId),
    );
  });
});
