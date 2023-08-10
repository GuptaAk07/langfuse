import { z } from "zod";

import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";

const UserFilterOptions = z.object({
  projectId: z.string(), // Required for protectedProjectProcedure
});

export const userRouter = createTRPCRouter({
  all: protectedProjectProcedure
    .input(UserFilterOptions)
    .query(async ({ input, ctx }) => {
      const traces = await ctx.prisma.trace.groupBy({
        where: {
          AND: [
            {
              projectId: input.projectId,
            },
          ],
        },
        by: ["userId", "id"],
      });

      const userIdToTraceIdsMap = traces.reduce((map, trace) => {
        const userId = trace.userId;
        const traceId = trace.id;

        if (userId) {
          if (!map.has(userId)) {
            map.set(userId, [traceId]);
          } else {
            map.get(userId)?.push(traceId);
          }
        }

        return map;
      }, new Map<string, string[]>());

      const userIds = Array.from(userIdToTraceIdsMap.keys());

      if (userIds.length === 0) {
        return [];
      }

      const [traceAnalytics, observationAnalytics, lastScore] =
        await Promise.all([
          ctx.prisma.trace.groupBy({
            where: {
              userId: {
                in: userIds,
              },
            },
            _count: {
              _all: true,
            },
            _min: {
              timestamp: true,
            },
            _max: {
              timestamp: true,
            },
            by: ["userId"],
          }),
          ctx.prisma.$queryRawUnsafe<
            {
              min_start_time: Date;
              max_start_time: Date;
              total_tokens: number;
              prompt_tokens: number;
              completion_tokens: number;
              total_observations: number;
              user_id: string;
            }[]
          >(`SELECT
          MIN(observations.start_time) AS min_start_time,
          MAX(observations.start_time) AS max_start_time,
          SUM(observations.total_tokens) AS total_tokens,
          SUM(observations.prompt_tokens) AS prompt_tokens,
          SUM(observations.completion_tokens) AS completion_tokens,
          count(*) as total_observations,
          traces.user_id as user_id
        FROM
          observations
          JOIN traces ON observations.trace_id = traces.id
        WHERE
          traces.user_id IN (${userIds.map((id) => `'${id}'`).join(",")})
        GROUP BY
          traces.user_id
          `),
          ctx.prisma.trace.findMany({
            distinct: ["userId"],
            orderBy: {
              timestamp: "desc",
            },
            include: {
              scores: {
                orderBy: {
                  timestamp: "desc",
                },
                take: 1,
              },
            },
            where: {
              userId: {
                in: userIds,
              },
            },
          }),
        ]);

      return userIds.map((userId) => {
        const traceAnalyticsForUser = traceAnalytics.find(
          (t) => t.userId === userId
        );
        const observationAnalyticsForUser = observationAnalytics.find(
          (o) => o.user_id === userId
        );

        if (!traceAnalyticsForUser || !observationAnalyticsForUser) {
          throw new Error("User not found in analytics");
        }

        const returnedScore =
          lastScore.find((s) => s.userId === userId)?.scores[0] ?? null;

        return {
          userId: userId,
          firstTrace: traceAnalyticsForUser._min?.timestamp,
          lastTrace: traceAnalyticsForUser?._max?.timestamp,
          totalTraces: traceAnalyticsForUser?._count?._all,
          totalPromptTokens: observationAnalyticsForUser.prompt_tokens ?? 0,
          totalCompletionTokens:
            observationAnalyticsForUser.completion_tokens ?? 0,
          totalTokens: observationAnalyticsForUser.total_tokens ?? 0,
          firstObservation: observationAnalyticsForUser.min_start_time,
          lastObservation: observationAnalyticsForUser.max_start_time,
          totalObservations: observationAnalyticsForUser.total_observations,
          lastScore: returnedScore,
        };
      });
    }),

  byId: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        userId: z.string(),
      })
    )
    .query(async ({ input, ctx }) => {
      const [traceAnalytics, observationAnalytics, lastScore] =
        await Promise.all([
          ctx.prisma.trace.aggregate({
            where: {
              userId: input.userId,
            },
            _count: {
              _all: true,
            },
            _min: {
              timestamp: true,
            },
            _max: {
              timestamp: true,
            },
          }),
          ctx.prisma.$queryRaw<
            {
              sumPromptTokens: number;
              sumCompletionTokens: number;
              sumTotalTokens: number;
              minStartTime: Date;
              maxEndTime: Date;
              totalObservations: number;
            }[]
          >`
          SELECT  sum(prompt_tokens) as "sumPromptTokens", 
                  sum(completion_tokens) as "sumCompletionTokens", 
                  sum(total_tokens) as "sumTotalTokens",
                  min(start_time) as "minStartTime",
                  max(end_time) as "maxEndTime", 
                  count(*) as "totalObservations" 
          FROM observations o join traces t on o.trace_id = t.id where t.user_id = ${input.userId}
          `,
          ctx.prisma.score.findFirst({
            where: {
              trace: {
                userId: input.userId,
              },
            },
            orderBy: {
              timestamp: "desc",
            },
            take: 1,
          }),
        ]);

      return {
        userId: input.userId,
        firstTrace: traceAnalytics._min.timestamp,
        lastTrace: traceAnalytics._max.timestamp,
        totalTraces: traceAnalytics._count._all,
        totalPromptTokens: observationAnalytics[0]?.sumTotalTokens ?? 0,
        totalCompletionTokens:
          observationAnalytics[0]?.sumCompletionTokens ?? 0,
        totalTokens: observationAnalytics[0]?.sumTotalTokens ?? 0,
        firstObservation: observationAnalytics[0]?.minStartTime,
        lastObservation: observationAnalytics[0]?.maxEndTime,
        totalObservations: observationAnalytics[0]?.totalObservations,
        lastScore: lastScore,
      };
    }),
});
