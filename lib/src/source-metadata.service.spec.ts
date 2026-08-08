import { Project } from "ts-morph";
import { SourceMetadataService } from "./source-metadata.service";

type SourceMetadataServiceInternals = {
  createProject(): Project;
  buildClassIndexes(): unknown;
};

describe(SourceMetadataService.name, () => {
  it("lazily initializes one project and reuses indexed class and method lookups", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "source-metadata.ts",
      `
        /**
         * Cached source documentation.
         */
        class CachedSourceMetadata {
          execute(value: string) {
            return value;
          }
        }
      `,
    );
    const service = new SourceMetadataService();
    const internals = service as unknown as SourceMetadataServiceInternals;
    const createProjectSpy = jest
      .spyOn(internals, "createProject")
      .mockReturnValue(project);
    const buildClassIndexesSpy = jest.spyOn(internals, "buildClassIndexes");

    expect(createProjectSpy).not.toHaveBeenCalled();
    expect(buildClassIndexesSpy).not.toHaveBeenCalled();

    expect(service.getClassJsDoc("CachedSourceMetadata")).toBe(
      "Cached source documentation.",
    );
    const firstMethod = service.getInstanceMethod(
      "CachedSourceMetadata",
      "execute",
    );
    const secondMethod = service.getInstanceMethod(
      "CachedSourceMetadata",
      "execute",
    );

    expect(firstMethod).toBeDefined();
    expect(secondMethod).toBe(firstMethod);
    expect(createProjectSpy).toHaveBeenCalledTimes(1);
    expect(buildClassIndexesSpy).toHaveBeenCalledTimes(1);
  });
});
