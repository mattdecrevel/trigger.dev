import { Span, SpanKind, SpanOptions, context, propagation, trace } from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGE_ID,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
import { flattenAttributes } from "@trigger.dev/core/v3";
import Redis, { type Callback, type RedisOptions, type Result } from "ioredis";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { attributesFromAuthenticatedEnv } from "../tracer.server";
import { AsyncWorker } from "./asyncWorker.server";
import { MarQSShortKeyProducer } from "./marqsKeyProducer.server";
import { SimpleWeightedChoiceStrategy } from "./priorityStrategy.server";
import {
  MarQSKeyProducer,
  MarQSQueuePriorityStrategy,
  MessagePayload,
  QueueCapacities,
} from "./types";

const tracer = trace.getTracer("marqs");

const KEY_PREFIX = "marqs:";

const constants = {
  SHARED_QUEUE: "sharedQueue",
  MESSAGE_VISIBILITY_TIMEOUT_QUEUE: "msgVisibilityTimeout",
} as const;

const SemanticAttributes = {
  QUEUE: "marqs.queue",
  PARENT_QUEUE: "marqs.parentQueue",
  MESSAGE_ID: "marqs.messageId",
  CONCURRENCY_KEY: "marqs.concurrencyKey",
};

export type MarQSOptions = {
  redis: RedisOptions;
  defaultQueueConcurrency: number;
  defaultEnvConcurrency: number;
  defaultOrgConcurrency: number;
  windowSize?: number;
  visibilityTimeoutInMs?: number;
  workers: number;
  keysProducer: MarQSKeyProducer;
  queuePriorityStrategy: MarQSQueuePriorityStrategy;
  envQueuePriorityStrategy: MarQSQueuePriorityStrategy;
};

/**
 * MarQS - Multitenant Asynchronous Reliable Queueing System (pronounced "markus")
 */
export class MarQS {
  private redis: Redis;
  private keys: MarQSKeyProducer;
  private queuePriorityStrategy: MarQSQueuePriorityStrategy;
  #requeueingWorkers: Array<AsyncWorker> = [];

  constructor(private readonly options: MarQSOptions) {
    this.redis = new Redis(options.redis);

    // Spawn options.workers workers to requeue visible messages
    this.#startRequeuingWorkers();
    this.#registerCommands();

    this.keys = options.keysProducer;
    this.queuePriorityStrategy = options.queuePriorityStrategy;
  }

  public async updateQueueConcurrencyLimits(
    env: AuthenticatedEnvironment,
    queue: string,
    concurrency: number
  ) {
    return this.redis.set(this.keys.queueConcurrencyLimitKey(env, queue), concurrency);
  }

  public async updateEnvConcurrencyLimits(env: AuthenticatedEnvironment) {
    await this.#callUpdateGlobalConcurrencyLimits({
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKey(env),
      orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKey(env),
      envConcurrencyLimit: env.maximumConcurrencyLimit,
      orgConcurrencyLimit: env.organization.maximumConcurrencyLimit,
    });
  }

  public async enqueueMessage(
    env: AuthenticatedEnvironment,
    queue: string,
    messageId: string,
    messageData: Record<string, unknown>,
    concurrencyKey?: string
  ) {
    return await this.#trace(
      "enqueueMessage",
      async (span) => {
        const messageQueue = this.keys.queueKey(env, queue, concurrencyKey);

        const timestamp = Date.now();

        const parentQueue = this.keys.envSharedQueueKey(env);

        propagation.inject(context.active(), messageData);

        const messagePayload: MessagePayload = {
          version: "1",
          data: messageData,
          queue: messageQueue,
          concurrencyKey,
          timestamp,
          messageId,
          parentQueue,
        };

        span.setAttributes({
          [SemanticAttributes.QUEUE]: queue,
          [SemanticAttributes.MESSAGE_ID]: messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: parentQueue,
        });

        await this.#callEnqueueMessage(messagePayload);
      },
      {
        kind: SpanKind.PRODUCER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "publish",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
          ...attributesFromAuthenticatedEnv(env),
        },
      }
    );
  }

  public async dequeueMessageInEnv(env: AuthenticatedEnvironment) {
    return this.#trace(
      "dequeueMessageInEnv",
      async (span, abort) => {
        const parentQueue = this.keys.envSharedQueueKey(env);

        // Read the parent queue for matching queues
        const messageQueue = await this.#getRandomQueueFromParentQueue(
          parentQueue,
          this.options.envQueuePriorityStrategy,
          (queue) => this.#calculateMessageQueueCapacities(queue)
        );

        if (!messageQueue) {
          abort();
          return;
        }

        const messageData = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
          currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
          envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
          envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
          orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKeyFromQueue(messageQueue),
          orgCurrentConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(messageQueue),
        });

        if (!messageData) {
          abort();
          return;
        }

        const message = await this.#readMessage(messageData.messageId);

        if (message) {
          span.setAttributes({
            [SEMATTRS_MESSAGE_ID]: message.messageId,
            [SemanticAttributes.QUEUE]: message.queue,
            [SemanticAttributes.MESSAGE_ID]: message.messageId,
            [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
            [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
          });
        } else {
          abort();
        }

        return message;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
          ...attributesFromAuthenticatedEnv(env),
        },
      }
    );
  }

  /**
   * Dequeue a message from the shared queue (this should be used in production environments)
   */
  public async dequeueMessageInSharedQueue() {
    return this.#trace(
      "dequeueMessageInSharedQueue",
      async (span, abort) => {
        const parentQueue = constants.SHARED_QUEUE;

        // Read the parent queue for matching queues
        const messageQueue = await this.#getRandomQueueFromParentQueue(
          parentQueue,
          this.options.queuePriorityStrategy,
          (queue) => this.#calculateMessageQueueCapacities(queue)
        );

        if (!messageQueue) {
          abort();
          return;
        }

        // If the queue includes a concurrency key, we need to remove the ck:concurrencyKey from the queue name
        const messageData = await this.#callDequeueMessage({
          messageQueue,
          parentQueue,
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(messageQueue),
          currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(messageQueue),
          envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(messageQueue),
          envCurrentConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(messageQueue),
          orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKeyFromQueue(messageQueue),
          orgCurrentConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(messageQueue),
        });

        if (!messageData) {
          abort();
          return;
        }

        const message = await this.#readMessage(messageData.messageId);

        if (message) {
          span.setAttributes({
            [SEMATTRS_MESSAGE_ID]: message.messageId,
            [SemanticAttributes.QUEUE]: message.queue,
            [SemanticAttributes.MESSAGE_ID]: message.messageId,
            [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
            [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
          });
        } else {
          abort();
        }

        return message;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  public async acknowledgeMessage(messageId: string) {
    return this.#trace(
      "acknowledgeMessage",
      async (span) => {
        const message = await this.#readMessage(messageId);

        if (!message) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        await this.#callAcknowledgeMessage({
          messageKey: this.keys.messageKey(messageId),
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue),
          messageId,
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "ack",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  public async replaceMessage(
    messageId: string,
    messageData: Record<string, unknown>,
    timestamp?: number
  ) {
    return this.#trace(
      "replaceMessage",
      async (span) => {
        const oldMessage = await this.#readMessage(messageId);

        if (!oldMessage) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: oldMessage.queue,
          [SemanticAttributes.MESSAGE_ID]: oldMessage.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: oldMessage.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: oldMessage.parentQueue,
        });

        await this.#callAcknowledgeMessage({
          messageKey: this.keys.messageKey(messageId),
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(oldMessage.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(oldMessage.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(oldMessage.queue),
          messageId,
        });

        const newMessage: MessagePayload = {
          version: "1",
          data: messageData,
          queue: oldMessage.queue,
          concurrencyKey: oldMessage.concurrencyKey,
          timestamp: timestamp ?? Date.now(),
          messageId,
          parentQueue: oldMessage.parentQueue,
        };

        await this.#callEnqueueMessage(newMessage);
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "replace",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  async #trace<T>(
    name: string,
    fn: (span: Span, abort: () => void) => Promise<T>,
    options?: SpanOptions
  ): Promise<T> {
    return tracer.startActiveSpan(name, options ?? {}, async (span) => {
      let _abort = false;
      let aborter = () => {
        _abort = true;
      };

      try {
        return await fn(span, aborter);
      } catch (e) {
        if (e instanceof Error) {
          span.recordException(e);
        } else {
          span.recordException(new Error(String(e)));
        }

        throw e;
      } finally {
        if (!_abort) {
          span.end();
        }
      }
    });
  }

  /**
   * Negative acknowledge a message, which will requeue the message
   */
  public async nackMessage(messageId: string, retryAt: number = Date.now()) {
    return this.#trace(
      "nackMessage",
      async (span) => {
        const message = await this.#readMessage(messageId);

        if (!message) {
          return;
        }

        span.setAttributes({
          [SemanticAttributes.QUEUE]: message.queue,
          [SemanticAttributes.MESSAGE_ID]: message.messageId,
          [SemanticAttributes.CONCURRENCY_KEY]: message.concurrencyKey,
          [SemanticAttributes.PARENT_QUEUE]: message.parentQueue,
        });

        await this.#callNackMessage({
          messageKey: this.keys.messageKey(messageId),
          messageQueue: message.queue,
          parentQueue: message.parentQueue,
          concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(message.queue),
          envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(message.queue),
          orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(message.queue),
          visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
          messageId,
          messageScore: retryAt,
        });
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "nack",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
        },
      }
    );
  }

  // This should increment by the number of seconds, but with a max value of Date.now() + visibilityTimeoutInMs
  public async heartbeatMessage(messageId: string, seconds: number = 30) {
    await this.#callHeartbeatMessage({
      visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
      messageId,
      milliseconds: seconds * 1000,
      maxVisibilityTimeout: Date.now() + this.visibilityTimeoutInMs,
    });
  }

  get visibilityTimeoutInMs() {
    return this.options.visibilityTimeoutInMs ?? 300000;
  }

  async #readMessage(messageId: string) {
    return this.#trace(
      "readMessage",
      async (span) => {
        const rawMessage = await this.redis.get(this.keys.messageKey(messageId));

        if (!rawMessage) {
          return;
        }

        const message = MessagePayload.safeParse(JSON.parse(rawMessage));

        if (!message.success) {
          logger.error("Failed to parse message", {
            messageId,
            error: message.error,
          });

          return;
        }

        return message.data;
      },
      {
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGE_ID]: messageId,
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
          [SemanticAttributes.MESSAGE_ID]: messageId,
        },
      }
    );
  }

  async #getRandomQueueFromParentQueue(
    parentQueue: string,
    queuePriorityStrategy: MarQSQueuePriorityStrategy,
    calculateCapacities: (queue: string) => Promise<QueueCapacities>
  ) {
    return this.#trace(
      "getRandomQueueFromParentQueue",
      async (span, abort) => {
        const { range, selectionId } = await queuePriorityStrategy.nextCandidateSelection(
          parentQueue
        );

        const queues = await this.#zrangeWithScores(parentQueue, range[0], range[1]);

        const queuesWithScores = await this.#calculateQueueScores(queues, calculateCapacities);

        // We need to priority shuffle here to ensure all workers aren't just working on the highest priority queue
        const choice = this.queuePriorityStrategy.chooseQueue(
          queuesWithScores,
          parentQueue,
          selectionId
        );

        if (typeof choice !== "string") {
          abort();
          return;
        }

        span.setAttributes({
          ...flattenAttributes(queues, "marqs.queues"),
        });
        span.setAttributes({
          ...flattenAttributes(queuesWithScores, "marqs.queuesWithScores"),
        });
        span.setAttribute("marqs.nextRange", range);
        span.setAttribute("marqs.queueCount", queues.length);
        span.setAttribute("marqs.queueChoice", choice);

        return choice;
      },
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          [SEMATTRS_MESSAGING_OPERATION]: "receive",
          [SEMATTRS_MESSAGING_SYSTEM]: "marqs",
          [SemanticAttributes.PARENT_QUEUE]: parentQueue,
        },
      }
    );
  }

  // Calculate the weights of the queues based on the age and the capacity
  async #calculateQueueScores(
    queues: Array<{ value: string; score: number }>,
    calculateCapacities: (queue: string) => Promise<QueueCapacities>
  ) {
    const now = Date.now();

    const queueScores = await Promise.all(
      queues.map(async (queue) => {
        return {
          queue: queue.value,
          capacities: await calculateCapacities(queue.value),
          age: now - queue.score,
        };
      })
    );

    return queueScores;
  }

  async #calculateMessageQueueCapacities(queue: string) {
    return await this.#callCalculateMessageCapacities({
      currentConcurrencyKey: this.keys.currentConcurrencyKeyFromQueue(queue),
      currentEnvConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(queue),
      currentOrgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(queue),
      concurrencyLimitKey: this.keys.concurrencyLimitKeyFromQueue(queue),
      envConcurrencyLimitKey: this.keys.envConcurrencyLimitKeyFromQueue(queue),
      orgConcurrencyLimitKey: this.keys.orgConcurrencyLimitKeyFromQueue(queue),
    });
  }

  async #zrangeWithScores(
    key: string,
    min: number,
    max: number
  ): Promise<Array<{ value: string; score: number }>> {
    const valuesWithScores = await this.redis.zrange(key, min, max, "WITHSCORES");
    const result: Array<{ value: string; score: number }> = [];

    for (let i = 0; i < valuesWithScores.length; i += 2) {
      result.push({
        value: valuesWithScores[i],
        score: Number(valuesWithScores[i + 1]),
      });
    }

    return result;
  }

  #startRequeuingWorkers() {
    // Start a new worker to requeue visible messages
    for (let i = 0; i < this.options.workers; i++) {
      const worker = new AsyncWorker(this.#requeueVisibleMessages.bind(this), 1000);

      this.#requeueingWorkers.push(worker);

      worker.start();
    }
  }

  async #requeueVisibleMessages() {
    // Remove any of the messages from the timeoutQueue that have expired
    const messages = await this.redis.zrangebyscore(
      constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
      0,
      Date.now(),
      "LIMIT",
      0,
      10
    );

    if (messages.length === 0) {
      return;
    }

    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];

      const messageData = await this.redis.get(this.keys.messageKey(message));

      if (!messageData) {
        // The message has been removed for some reason (TTL, etc.), so we should remove it from the timeout queue
        await this.redis.zrem(constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE, message);

        continue;
      }

      const parsedMessage = MessagePayload.safeParse(JSON.parse(messageData));

      if (!parsedMessage.success) {
        await this.redis.zrem(constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE, message);

        continue;
      }

      await this.#callNackMessage({
        messageKey: this.keys.messageKey(message),
        messageQueue: parsedMessage.data.queue,
        parentQueue: parsedMessage.data.parentQueue,
        concurrencyKey: this.keys.currentConcurrencyKeyFromQueue(parsedMessage.data.queue),
        envConcurrencyKey: this.keys.envCurrentConcurrencyKeyFromQueue(parsedMessage.data.queue),
        orgConcurrencyKey: this.keys.orgCurrentConcurrencyKeyFromQueue(parsedMessage.data.queue),
        visibilityQueue: constants.MESSAGE_VISIBILITY_TIMEOUT_QUEUE,
        messageId: parsedMessage.data.messageId,
        messageScore: parsedMessage.data.timestamp,
      });
    }
  }

  async #callEnqueueMessage(message: MessagePayload) {
    logger.debug("Calling enqueueMessage", {
      messagePayload: message,
    });

    return this.redis.enqueueMessage(
      message.queue,
      message.parentQueue,
      this.keys.messageKey(message.messageId),
      message.queue,
      message.messageId,
      JSON.stringify(message),
      String(message.timestamp)
    );
  }

  async #callDequeueMessage({
    messageQueue,
    parentQueue,
    visibilityQueue,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    orgConcurrencyLimitKey,
    currentConcurrencyKey,
    envCurrentConcurrencyKey,
    orgCurrentConcurrencyKey,
  }: {
    messageQueue: string;
    parentQueue: string;
    visibilityQueue: string;
    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;
    orgConcurrencyLimitKey: string;
    currentConcurrencyKey: string;
    envCurrentConcurrencyKey: string;
    orgCurrentConcurrencyKey: string;
  }) {
    const result = await this.redis.dequeueMessage(
      messageQueue,
      parentQueue,
      visibilityQueue,
      concurrencyLimitKey,
      envConcurrencyLimitKey,
      orgConcurrencyLimitKey,
      currentConcurrencyKey,
      envCurrentConcurrencyKey,
      orgCurrentConcurrencyKey,
      messageQueue,
      String(this.options.visibilityTimeoutInMs ?? 300000), // 5 minutes
      String(Date.now()),
      String(this.options.defaultQueueConcurrency),
      String(this.options.defaultEnvConcurrency),
      String(this.options.defaultOrgConcurrency)
    );

    if (!result) {
      return;
    }

    logger.debug("Dequeue message result", {
      result,
    });

    if (result.length !== 2) {
      return;
    }

    return {
      messageId: result[0],
      messageScore: result[1],
    };
  }

  async #callAcknowledgeMessage({
    messageKey,
    visibilityQueue,
    concurrencyKey,
    envConcurrencyKey,
    orgConcurrencyKey,
    messageId,
  }: {
    messageKey: string;
    visibilityQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    orgConcurrencyKey: string;
    messageId: string;
  }) {
    logger.debug("Calling acknowledgeMessage", {
      messageKey,
      visibilityQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      messageId,
    });

    return this.redis.acknowledgeMessage(
      messageKey,
      visibilityQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      messageId
    );
  }

  async #callNackMessage({
    messageKey,
    messageQueue,
    parentQueue,
    concurrencyKey,
    envConcurrencyKey,
    orgConcurrencyKey,
    visibilityQueue,
    messageId,
    messageScore,
  }: {
    messageKey: string;
    messageQueue: string;
    parentQueue: string;
    concurrencyKey: string;
    envConcurrencyKey: string;
    orgConcurrencyKey: string;
    visibilityQueue: string;
    messageId: string;
    messageScore: number;
  }) {
    logger.debug("Calling nackMessage", {
      messageKey,
      messageQueue,
      parentQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      visibilityQueue,
      messageId,
      messageScore,
    });

    return this.redis.nackMessage(
      messageKey,
      messageQueue,
      parentQueue,
      concurrencyKey,
      envConcurrencyKey,
      orgConcurrencyKey,
      visibilityQueue,
      messageQueue,
      messageId,
      String(Date.now()),
      String(messageScore)
    );
  }

  #callHeartbeatMessage({
    visibilityQueue,
    messageId,
    milliseconds,
    maxVisibilityTimeout,
  }: {
    visibilityQueue: string;
    messageId: string;
    milliseconds: number;
    maxVisibilityTimeout: number;
  }) {
    return this.redis.heartbeatMessage(
      visibilityQueue,
      messageId,
      String(milliseconds),
      String(maxVisibilityTimeout)
    );
  }

  async #callCalculateMessageCapacities({
    currentConcurrencyKey,
    currentEnvConcurrencyKey,
    currentOrgConcurrencyKey,
    concurrencyLimitKey,
    envConcurrencyLimitKey,
    orgConcurrencyLimitKey,
  }: {
    currentConcurrencyKey: string;
    currentEnvConcurrencyKey: string;
    currentOrgConcurrencyKey: string;
    concurrencyLimitKey: string;
    envConcurrencyLimitKey: string;
    orgConcurrencyLimitKey: string;
  }): Promise<QueueCapacities> {
    const capacities = await this.redis.calculateMessageQueueCapacities(
      currentConcurrencyKey,
      currentEnvConcurrencyKey,
      currentOrgConcurrencyKey,
      concurrencyLimitKey,
      envConcurrencyLimitKey,
      orgConcurrencyLimitKey,
      String(this.options.defaultQueueConcurrency),
      String(this.options.defaultEnvConcurrency),
      String(this.options.defaultOrgConcurrency)
    );

    // [queue current, queue limit, env current, env limit, org current, org limit]
    return {
      queue: { current: Number(capacities[0]), limit: Number(capacities[1]) },
      env: { current: Number(capacities[2]), limit: Number(capacities[3]) },
      org: { current: Number(capacities[4]), limit: Number(capacities[5]) },
    };
  }

  #callUpdateGlobalConcurrencyLimits({
    envConcurrencyLimitKey,
    orgConcurrencyLimitKey,
    envConcurrencyLimit,
    orgConcurrencyLimit,
  }: {
    envConcurrencyLimitKey: string;
    orgConcurrencyLimitKey: string;
    envConcurrencyLimit: number;
    orgConcurrencyLimit: number;
  }) {
    return this.redis.updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey,
      orgConcurrencyLimitKey,
      String(envConcurrencyLimit),
      String(orgConcurrencyLimit)
    );
  }

  #registerCommands() {
    this.redis.defineCommand("enqueueMessage", {
      numberOfKeys: 3,
      lua: `
local queue = KEYS[1]
local parentQueue = KEYS[2]
local messageKey = KEYS[3]

local queueName = ARGV[1]
local messageId = ARGV[2]
local messageData = ARGV[3]
local messageScore = ARGV[4]

-- Write the message to the message key
redis.call('SET', messageKey, messageData)

-- Add the message to the queue
redis.call('ZADD', queue, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', queue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, queueName)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], queueName)
end
      `,
    });

    this.redis.defineCommand("dequeueMessage", {
      numberOfKeys: 9,
      lua: `
-- Keys: childQueue, parentQueue, visibilityQueue, concurrencyLimitKey, envConcurrencyLimitKey, orgConcurrencyLimitKey, currentConcurrencyKey, envCurrentConcurrencyKey, orgCurrentConcurrencyKey
local childQueue = KEYS[1]
local parentQueue = KEYS[2]
local visibilityQueue = KEYS[3]
local concurrencyLimitKey = KEYS[4]
local envConcurrencyLimitKey = KEYS[5]
local orgConcurrencyLimitKey = KEYS[6]
local currentConcurrencyKey = KEYS[7]
local envCurrentConcurrencyKey = KEYS[8]
local orgCurrentConcurrencyKey = KEYS[9]

-- Args: childQueueName, visibilityQueue, currentTime, defaultConcurrencyLimit, defaultEnvConcurrencyLimit, defaultOrgConcurrencyLimit
local childQueueName = ARGV[1]
local visibilityTimeout = tonumber(ARGV[2])
local currentTime = tonumber(ARGV[3])
local defaultConcurrencyLimit = ARGV[4]
local defaultEnvConcurrencyLimit = ARGV[5]
local defaultOrgConcurrencyLimit = ARGV[6]

-- Check current org concurrency against the limit
local orgCurrentConcurrency = tonumber(redis.call('SCARD', orgCurrentConcurrencyKey) or '0')
local orgConcurrencyLimit = tonumber(redis.call('GET', orgConcurrencyLimitKey) or defaultOrgConcurrencyLimit)

if orgCurrentConcurrency >= orgConcurrencyLimit then
    return nil
end

-- Check current env concurrency against the limit
local envCurrentConcurrency = tonumber(redis.call('SCARD', envCurrentConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

if envCurrentConcurrency >= envConcurrencyLimit then
    return nil
end

-- Check current queue concurrency against the limit
local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = tonumber(redis.call('GET', concurrencyLimitKey) or defaultConcurrencyLimit)

if currentConcurrency >= concurrencyLimit then
    return nil
end

-- Attempt to dequeue the next message
local messages = redis.call('ZRANGEBYSCORE', childQueue, '-inf', currentTime, 'WITHSCORES', 'LIMIT', 0, 1)

if #messages == 0 then
    return nil
end

local messageId = messages[1]
local messageScore = tonumber(messages[2])
local timeoutScore = currentTime + visibilityTimeout

-- Move message to timeout queue and update concurrency
redis.call('ZREM', childQueue, messageId)
redis.call('ZADD', visibilityQueue, timeoutScore, messageId)
redis.call('SADD', currentConcurrencyKey, messageId)
redis.call('SADD', envCurrentConcurrencyKey, messageId)
redis.call('SADD', orgCurrentConcurrencyKey, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', childQueue, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueue, childQueueName)
else
    redis.call('ZADD', parentQueue, earliestMessage[2], childQueueName)
end

return {messageId, messageScore} -- Return message details
      `,
    });

    this.redis.defineCommand("acknowledgeMessage", {
      numberOfKeys: 5,
      lua: `
-- Keys: messageKey, visibilityQueue, concurrencyKey, envCurrentConcurrencyKey, orgCurrentConcurrencyKey
local messageKey = KEYS[1]
local visibilityQueue = KEYS[2]
local concurrencyKey = KEYS[3]
local envCurrentConcurrencyKey = KEYS[4]
local orgCurrentConcurrencyKey = KEYS[5]
local globalCurrentConcurrencyKey = KEYS[6]

-- Args: messageId
local messageId = ARGV[1]

-- Remove the message from the message key
redis.call('DEL', messageKey)

-- Remove the message from the timeout queue
redis.call('ZREM', visibilityQueue, messageId)

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envCurrentConcurrencyKey, messageId)
redis.call('SREM', orgCurrentConcurrencyKey, messageId)
`,
    });

    this.redis.defineCommand("nackMessage", {
      numberOfKeys: 7,
      lua: `
-- Keys: childQueueKey, parentQueueKey, visibilityQueue, concurrencyKey, envConcurrencyKey, orgConcurrencyKey, messageId
local messageKey = KEYS[1]
local childQueueKey = KEYS[2]
local parentQueueKey = KEYS[3]
local concurrencyKey = KEYS[4]
local envConcurrencyKey = KEYS[5]
local orgConcurrencyKey = KEYS[6]
local visibilityQueue = KEYS[7]

-- Args: childQueueName, messageId, currentTime, messageScore
local childQueueName = ARGV[1]
local messageId = ARGV[2]
local currentTime = tonumber(ARGV[3])
local messageScore = tonumber(ARGV[4])

-- Check to see if the message is still in the visibilityQueue
local messageVisibility = tonumber(redis.call('ZSCORE', visibilityQueue, messageId)) or 0

if messageVisibility == 0 then
    return
end

-- Update the concurrency keys
redis.call('SREM', concurrencyKey, messageId)
redis.call('SREM', envConcurrencyKey, messageId)
redis.call('SREM', orgConcurrencyKey, messageId)

-- Remove the message from the timeout queue
redis.call('ZREM', visibilityQueue, messageId)

-- Enqueue the message into the queue
redis.call('ZADD', childQueueKey, messageScore, messageId)

-- Rebalance the parent queue
local earliestMessage = redis.call('ZRANGE', childQueueKey, 0, 0, 'WITHSCORES')
if #earliestMessage == 0 then
    redis.call('ZREM', parentQueueKey, childQueueName)
else
    redis.call('ZADD', parentQueueKey, earliestMessage[2], childQueueName)
end
`,
    });

    this.redis.defineCommand("heartbeatMessage", {
      numberOfKeys: 1,
      lua: `
-- Keys: visibilityQueue
local visibilityQueue = KEYS[1]

-- Args: messageId, milliseconds, maxVisibilityTimeout
local messageId = ARGV[1]
local milliseconds = tonumber(ARGV[2])
local maxVisibilityTimeout = tonumber(ARGV[3])

-- Get the current visibility timeout
local currentVisibilityTimeout = tonumber(redis.call('ZSCORE', visibilityQueue, messageId)) or 0

if currentVisibilityTimeout == 0 then
    return
end

-- Calculate the new visibility timeout
local newVisibilityTimeout = math.min(currentVisibilityTimeout + milliseconds * 1000, maxVisibilityTimeout)

-- Update the visibility timeout
redis.call('ZADD', visibilityQueue, newVisibilityTimeout, messageId)
      `,
    });

    this.redis.defineCommand("calculateMessageQueueCapacities", {
      numberOfKeys: 6,
      lua: `
-- Keys: currentConcurrencyKey, currentEnvConcurrencyKey, currentOrgConcurrencyKey, concurrencyLimitKey, envConcurrencyLimitKey, orgConcurrencyLimitKey
local currentConcurrencyKey = KEYS[1]
local currentEnvConcurrencyKey = KEYS[2]
local currentOrgConcurrencyKey = KEYS[3]
local concurrencyLimitKey = KEYS[4]
local envConcurrencyLimitKey = KEYS[5]
local orgConcurrencyLimitKey = KEYS[6]

-- Args defaultConcurrencyLimit, defaultEnvConcurrencyLimit, defaultOrgConcurrencyLimit
local defaultConcurrencyLimit = tonumber(ARGV[1])
local defaultEnvConcurrencyLimit = tonumber(ARGV[2])
local defaultOrgConcurrencyLimit = tonumber(ARGV[3])

local currentOrgConcurrency = tonumber(redis.call('SCARD', currentOrgConcurrencyKey) or '0')
local orgConcurrencyLimit = tonumber(redis.call('GET', orgConcurrencyLimitKey) or defaultOrgConcurrencyLimit)

local currentEnvConcurrency = tonumber(redis.call('SCARD', currentEnvConcurrencyKey) or '0')
local envConcurrencyLimit = tonumber(redis.call('GET', envConcurrencyLimitKey) or defaultEnvConcurrencyLimit)

local currentConcurrency = tonumber(redis.call('SCARD', currentConcurrencyKey) or '0')
local concurrencyLimit = tonumber(redis.call('GET', concurrencyLimitKey) or defaultConcurrencyLimit)

-- Return current capacity and concurrency limits for the queue, env, org
return { currentConcurrency, concurrencyLimit, currentEnvConcurrency, envConcurrencyLimit, currentOrgConcurrency, orgConcurrencyLimit } 
      `,
    });

    this.redis.defineCommand("updateGlobalConcurrencyLimits", {
      numberOfKeys: 2,
      lua: `
-- Keys: envConcurrencyLimitKey, orgConcurrencyLimitKey
local envConcurrencyLimitKey = KEYS[1]
local orgConcurrencyLimitKey = KEYS[2]

-- Args: envConcurrencyLimit, orgConcurrencyLimit
local envConcurrencyLimit = ARGV[1]
local orgConcurrencyLimit = ARGV[2]

redis.call('SET', envConcurrencyLimitKey, envConcurrencyLimit)
redis.call('SET', orgConcurrencyLimitKey, orgConcurrencyLimit)
      `,
    });
  }
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    enqueueMessage(
      queue: string,
      parentQueue: string,
      messageKey: string,
      queueName: string,
      messageId: string,
      messageData: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    dequeueMessage(
      childQueue: string,
      parentQueue: string,
      visibilityQueue: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      orgConcurrencyLimitKey: string,
      currentConcurrencyKey: string,
      envCurrentConcurrencyKey: string,
      orgCurrentConcurrencyKey: string,
      childQueueName: string,
      visibilityTimeout: string,
      currentTime: string,
      defaultConcurrencyLimit: string,
      defaultEnvConcurrencyLimit: string,
      defaultOrgConcurrencyLimit: string,
      callback?: Callback<[string, string]>
    ): Result<[string, string] | null, Context>;

    acknowledgeMessage(
      messageKey: string,
      visibilityQueue: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      orgConcurrencyKey: string,
      messageId: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    nackMessage(
      messageKey: string,
      childQueueKey: string,
      parentQueueKey: string,
      concurrencyKey: string,
      envConcurrencyKey: string,
      orgConcurrencyKey: string,
      visibilityQueue: string,
      childQueueName: string,
      messageId: string,
      currentTime: string,
      messageScore: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    heartbeatMessage(
      visibilityQueue: string,
      messageId: string,
      milliseconds: string,
      maxVisibilityTimeout: string,
      callback?: Callback<void>
    ): Result<void, Context>;

    calculateMessageQueueCapacities(
      currentConcurrencyKey: string,
      currentEnvConcurrencyKey: string,
      currentOrgConcurrencyKey: string,
      concurrencyLimitKey: string,
      envConcurrencyLimitKey: string,
      orgConcurrencyLimitKey: string,
      defaultConcurrencyLimit: string,
      defaultEnvConcurrencyLimit: string,
      defaultOrgConcurrencyLimit: string,
      callback?: Callback<number[]>
    ): Result<number[], Context>;

    updateGlobalConcurrencyLimits(
      envConcurrencyLimitKey: string,
      orgConcurrencyLimitKey: string,
      envConcurrencyLimit: string,
      orgConcurrencyLimit: string,
      callback?: Callback<void>
    ): Result<void, Context>;
  }
}

export const marqs = singleton("marqs", getMarQSClient);

function getMarQSClient() {
  if (env.V3_ENABLED) {
    if (env.REDIS_HOST && env.REDIS_PORT) {
      const redisOptions = {
        keyPrefix: KEY_PREFIX,
        port: env.REDIS_PORT,
        host: env.REDIS_HOST,
        username: env.REDIS_USERNAME,
        password: env.REDIS_PASSWORD,
        enableAutoPipelining: true,
        ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      };

      return new MarQS({
        keysProducer: new MarQSShortKeyProducer(KEY_PREFIX),
        queuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
        envQueuePriorityStrategy: new SimpleWeightedChoiceStrategy({ queueSelectionCount: 12 }),
        workers: 1,
        redis: redisOptions,
        defaultQueueConcurrency: env.DEFAULT_QUEUE_EXECUTION_CONCURRENCY_LIMIT,
        defaultEnvConcurrency: env.DEFAULT_ENV_EXECUTION_CONCURRENCY_LIMIT,
        defaultOrgConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
        visibilityTimeoutInMs: 120 * 1000, // 2 minutes,
      });
    } else {
      console.warn(
        "Could not initialize MarQS because process.env.REDIS_HOST and process.env.REDIS_PORT are required to be set. Trigger.dev v3 will not work without this."
      );
    }
  }
}

// Only allow alphanumeric characters, underscores, hyphens, and slashes (and only the first 128 characters)
export function sanitizeQueueName(queueName: string) {
  return queueName.replace(/[^a-zA-Z0-9_\-\/]/g, "").substring(0, 128);
}
