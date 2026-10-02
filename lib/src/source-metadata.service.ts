import { existsSync } from "node:fs";
import { join } from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import {
  ClassDeclaration,
  MethodDeclaration,
  Project,
  SyntaxKind,
} from "ts-morph";

/**
 * Lazily reads source metadata shared by graph discovery and direct-run
 * enrichment. The project and declaration indexes are intentionally local to
 * an inspector module instance so they reflect its consumer tsconfig.
 */
@Injectable()
export class SourceMetadataService {
  private readonly logger = new Logger(SourceMetadataService.name);
  private project: Project | undefined;
  private classIndexes:
    | {
        topLevel: Map<string, ClassDeclaration>;
        all: Map<string, ClassDeclaration>;
        ambiguous: Set<string>;
      }
    | undefined;
  private readonly classJsDocCache = new Map<string, string | undefined>();
  private readonly methodCache = new Map<
    string,
    MethodDeclaration | undefined
  >();

  getClassJsDoc(className: string): string | undefined {
    if (this.classJsDocCache.has(className)) {
      return this.classJsDocCache.get(className);
    }

    const jsdoc = this.getTopLevelClass(className)
      ?.getJsDocs()
      .map((doc) => doc.getCommentText())
      .filter((comment): comment is string => !!comment)
      .join("\n");
    this.classJsDocCache.set(className, jsdoc);

    return jsdoc;
  }

  getInstanceMethod(
    className: string,
    methodName: string,
  ): MethodDeclaration | undefined {
    const key = `${className}\u0000${methodName}`;
    if (this.methodCache.has(key)) {
      return this.methodCache.get(key);
    }

    const method = this.getClass(className)?.getInstanceMethod(methodName);
    this.methodCache.set(key, method);

    return method;
  }

  /**
   * Whether a method is safe to advertise and invoke as a Direct Run public
   * method: it must resolve to exactly one declared method on an
   * unambiguous class, and that method must carry neither `private` nor
   * `protected`. Fail-closed throughout — a method that cannot be found, or
   * whose class name resolves to more than one declaration across the
   * application's sources, is not public.
   */
  isPublicMethod(className: string, methodName: string): boolean {
    const method = this.getInstanceMethod(className, methodName);
    if (!method) {
      return false;
    }

    return !(
      method.hasModifier(SyntaxKind.PrivateKeyword) ||
      method.hasModifier(SyntaxKind.ProtectedKeyword)
    );
  }

  private getTopLevelClass(className: string): ClassDeclaration | undefined {
    return this.getClassIndexes().topLevel.get(className);
  }

  /**
   * `undefined` both when no class of this name was found and when more
   * than one class shares it — a caller cannot tell which declaration it
   * would be reading, so treating the name as unresolved is the only safe
   * choice for a check that gates method invocation.
   */
  private getClass(className: string): ClassDeclaration | undefined {
    const indexes = this.getClassIndexes();
    if (indexes.ambiguous.has(className)) {
      return undefined;
    }

    return indexes.all.get(className);
  }

  private getClassIndexes(): {
    topLevel: Map<string, ClassDeclaration>;
    all: Map<string, ClassDeclaration>;
    ambiguous: Set<string>;
  } {
    if (!this.classIndexes) {
      this.classIndexes = this.buildClassIndexes();
    }

    return this.classIndexes;
  }

  private buildClassIndexes(): {
    topLevel: Map<string, ClassDeclaration>;
    all: Map<string, ClassDeclaration>;
    ambiguous: Set<string>;
  } {
    const topLevel = new Map<string, ClassDeclaration>();
    const all = new Map<string, ClassDeclaration>();
    const ambiguous = new Set<string>();

    for (const sourceFile of this.getProject().getSourceFiles()) {
      for (const classDeclaration of sourceFile.getClasses()) {
        const name = classDeclaration.getName();
        if (!name) {
          continue;
        }

        if (!topLevel.has(name)) {
          topLevel.set(name, classDeclaration);
        }
      }

      for (const classDeclaration of sourceFile.getDescendantsOfKind(
        SyntaxKind.ClassDeclaration,
      )) {
        const name = classDeclaration.getName();
        if (!name) {
          continue;
        }

        if (!all.has(name)) {
          all.set(name, classDeclaration);
        } else if (all.get(name) !== classDeclaration) {
          ambiguous.add(name);
        }
      }
    }

    return { topLevel, all, ambiguous };
  }

  private getProject(): Project {
    if (!this.project) {
      this.project = this.createProject();
    }

    return this.project;
  }

  private createProject(): Project {
    const tsConfigFilePath = join(process.cwd(), "tsconfig.json");

    if (!existsSync(tsConfigFilePath)) {
      this.logger.warn(
        `Could not find tsconfig.json at ${tsConfigFilePath}; JSDoc metadata will be skipped.`,
      );
      return new Project();
    }

    return new Project({
      tsConfigFilePath,
      skipAddingFilesFromTsConfig: false,
    });
  }
}
