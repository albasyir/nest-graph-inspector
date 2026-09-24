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

  it("identifies which methods are safe to advertise and invoke as Direct Run public methods", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "private-source.ts",
      `
        class ProviderWithMixedVisibility {
          private secretMethod(): string {
            return "internal";
          }

          protected protectedMethod(): string {
            return "internal-ish";
          }

          publicMethod(): string {
            return "exposed";
          }
        }
      `,
    );
    const service = new SourceMetadataService();
    const internals = service as unknown as SourceMetadataServiceInternals;
    jest.spyOn(internals, "createProject").mockReturnValue(project);

    expect(
      service.isPublicMethod("ProviderWithMixedVisibility", "publicMethod"),
    ).toBe(true);
    expect(
      service.isPublicMethod("ProviderWithMixedVisibility", "secretMethod"),
    ).toBe(false);
    expect(
      service.isPublicMethod(
        "ProviderWithMixedVisibility",
        "protectedMethod",
      ),
    ).toBe(false);
  });

  it("fails closed for an unknown class or an unknown method", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "known-source.ts",
      `
        class KnownProvider {
          publicMethod(): string {
            return "exposed";
          }
        }
      `,
    );
    const service = new SourceMetadataService();
    const internals = service as unknown as SourceMetadataServiceInternals;
    jest.spyOn(internals, "createProject").mockReturnValue(project);

    expect(service.isPublicMethod("UnknownClass", "unknownMethod")).toBe(
      false,
    );
    expect(service.isPublicMethod("KnownProvider", "unknownMethod")).toBe(
      false,
    );
  });

  it("fails closed when the class name is ambiguous across the application's sources", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "ambiguous-a.ts",
      `
        class AmbiguousProvider {
          publicMethod(): string {
            return "a";
          }
        }
      `,
    );
    project.createSourceFile(
      "ambiguous-b.ts",
      `
        class AmbiguousProvider {
          publicMethod(): string {
            return "b";
          }
        }
      `,
    );
    const service = new SourceMetadataService();
    const internals = service as unknown as SourceMetadataServiceInternals;
    jest.spyOn(internals, "createProject").mockReturnValue(project);

    expect(
      service.isPublicMethod("AmbiguousProvider", "publicMethod"),
    ).toBe(false);
  });
});
