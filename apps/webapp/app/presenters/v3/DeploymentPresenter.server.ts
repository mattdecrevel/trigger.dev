import {
  DeploymentErrorData,
  TaskMetadataFailedToParseData,
  groupTaskMetadataIssuesByTask,
} from "@trigger.dev/core/v3";
import { WorkerDeployment, WorkerDeploymentStatus } from "@trigger.dev/database";
import { z } from "zod";
import { PrismaClient, prisma } from "~/db.server";
import { Organization } from "~/models/organization.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { safeJsonParse } from "~/utils/json";
import { getUsername } from "~/utils/username";

export class DeploymentPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    deploymentShortCode,
  }: {
    userId: User["id"];
    projectSlug: Project["slug"];
    organizationSlug: Organization["slug"];
    deploymentShortCode: WorkerDeployment["shortCode"];
  }) {
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
      },
      where: {
        slug: projectSlug,
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    const deployment = await this.#prismaClient.workerDeployment.findUniqueOrThrow({
      where: {
        projectId_shortCode: {
          projectId: project.id,
          shortCode: deploymentShortCode,
        },
      },
      select: {
        id: true,
        shortCode: true,
        version: true,
        errorData: true,
        environment: {
          select: {
            id: true,
            type: true,
            slug: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
        status: true,
        deployedAt: true,
        createdAt: true,
        promotions: {
          select: {
            label: true,
          },
        },
        worker: {
          select: {
            tasks: {
              select: {
                slug: true,
                exportName: true,
                filePath: true,
              },
              orderBy: {
                exportName: "asc",
              },
            },
          },
        },
        triggeredBy: {
          select: {
            id: true,
            name: true,
            displayName: true,
            avatarUrl: true,
          },
        },
      },
    });

    return {
      deployment: {
        id: deployment.id,
        shortCode: deployment.shortCode,
        version: deployment.version,
        status: deployment.status,
        createdAt: deployment.createdAt,
        deployedAt: deployment.deployedAt,
        tasks: deployment.worker?.tasks,
        label: deployment.promotions?.[0]?.label,
        environment: {
          id: deployment.environment.id,
          type: deployment.environment.type,
          slug: deployment.environment.slug,
          userId: deployment.environment.orgMember?.user.id,
          userName: getUsername(deployment.environment.orgMember?.user),
        },
        deployedBy: deployment.triggeredBy,
        errorData: this.#prepareErrorData(deployment.errorData),
      },
    };
  }

  #prepareErrorData(errorData: WorkerDeployment["errorData"]) {
    if (!errorData) {
      return;
    }

    const parsedErrorData = DeploymentErrorData.safeParse(errorData);

    if (!parsedErrorData.success) {
      return;
    }

    if (parsedErrorData.data.name === "TaskMetadataParseError") {
      const errorJson = safeJsonParse(parsedErrorData.data.stack);

      if (errorJson) {
        const parsedError = TaskMetadataFailedToParseData.safeParse(errorJson);

        if (parsedError.success) {
          return {
            name: parsedErrorData.data.name,
            message: parsedErrorData.data.message,
            stack: createTaskMetadataFailedErrorStack(parsedError.data),
          };
        } else {
          return {
            name: parsedErrorData.data.name,
            message: parsedErrorData.data.message,
          };
        }
      } else {
        return {
          name: parsedErrorData.data.name,
          message: parsedErrorData.data.message,
        };
      }
    }

    return {
      name: parsedErrorData.data.name,
      message: parsedErrorData.data.message,
      stack: parsedErrorData.data.stack,
    };
  }
}

function createTaskMetadataFailedErrorStack(
  data: z.infer<typeof TaskMetadataFailedToParseData>
): string {
  const stack = [];

  const groupedIssues = groupTaskMetadataIssuesByTask(data.tasks, data.zodIssues);

  for (const key in groupedIssues) {
    const taskWithIssues = groupedIssues[key];

    if (!taskWithIssues) {
      continue;
    }

    stack.push("\n");
    stack.push(`  ❯ ${taskWithIssues.exportName} in ${taskWithIssues.filePath}`);

    for (const issue of taskWithIssues.issues) {
      if (issue.path) {
        stack.push(`    x ${issue.path} ${issue.message}`);
      } else {
        stack.push(`    x ${issue.message}`);
      }
    }
  }

  return stack.join("\n");
}
