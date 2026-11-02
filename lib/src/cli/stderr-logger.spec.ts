import { createStderrLogger } from "./stderr-logger";

describe(createStderrLogger.name, () => {
  let written: string;
  const logger = createStderrLogger((text) => {
    written += text;
  });

  beforeEach(() => {
    written = "";
  });

  it("drops everything below a warning", () => {
    logger.log("Nest application successfully started", "NestApplication");
    logger.debug?.("debug", "Context");
    logger.verbose?.("verbose", "Context");

    expect(written).toBe("");
  });

  it("prints warnings and errors with their context, and an error's stack after it", () => {
    logger.warn("Something is off", "InstanceLoader");
    logger.error("It broke", "Error: It broke\n    at somewhere", "ExceptionHandler");
    logger.error("No stack", undefined, "Injector");

    expect(written).toBe(
      "[Nest] WARN [InstanceLoader] Something is off\n" +
        "[Nest] ERROR [ExceptionHandler] It broke\nError: It broke\n    at somewhere\n" +
        "[Nest] ERROR [Injector] No stack\n",
    );
  });

  it("prints a stack passed without a context after the message", () => {
    logger.error("It broke", "Error: It broke\n    at somewhere");

    expect(written).toBe(
      "[Nest] ERROR It broke\nError: It broke\n    at somewhere\n",
    );
  });

  it("prints an error object by its stack", () => {
    const error = new Error("Nest can't resolve dependencies");

    logger.error(error, "ExceptionHandler");

    expect(written).toBe(`[Nest] ERROR [ExceptionHandler] ${error.stack}\n`);
  });

  it("leaves out the banner Nest prints for preview mode, and nothing else", () => {
    for (const line of [
      "------------------------------------------------",
      "Application is running in the PREVIEW mode!",
      "Providers/controllers will not be instantiated.",
      "------------------------------------------------",
    ]) {
      logger.warn(line, "NestApplicationContext");
    }
    logger.warn("Application is running in the PREVIEW mode!", "SomethingElse");

    expect(written).toBe(
      "[Nest] WARN [SomethingElse] Application is running in the PREVIEW mode!\n",
    );
  });
});
