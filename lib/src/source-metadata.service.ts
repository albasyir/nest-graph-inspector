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

  private getTopLevelClass(className: string): ClassDeclaration | undefined {
    return this.getClassIndexes().topLevel.get(className);
  }

  private getClass(className: string): ClassDeclaration | undefined {
    return this.getClassIndexes().all.get(className);
  }

  private getClassIndexes(): {
    topLevel: Map<string, ClassDeclaration>;
    all: Map<string, ClassDeclaration>;
  } {
    if (!this.classIndexes) {
      this.classIndexes = this.buildClassIndexes();
    }

    return this.classIndexes;
  }

  private buildClassIndexes(): {
    topLevel: Map<string, ClassDeclaration>;
    all: Map<string, ClassDeclaration>;
  } {
    const topLevel = new Map<string, ClassDeclaration>();
    const all = new Map<string, ClassDeclaration>();

    for (const sourceFile of this.getProject().getSourceFiles()) {
      for (const classDeclaration of sourceFile.getClasses()) {
        const name = classDeclaration.getName();
        if (name && !topLevel.has(name)) {
          topLevel.set(name, classDeclaration);
        }
      }

      for (const classDeclaration of sourceFile.getDescendantsOfKind(
        SyntaxKind.ClassDeclaration,
      )) {
        const name = classDeclaration.getName();
        if (name && !all.has(name)) {
          all.set(name, classDeclaration);
        }
      }
    }

    return { topLevel, all };
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
