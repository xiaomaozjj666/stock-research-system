import { errorResponse, jsonBody, jsonOk } from '../shared.js';

export const improvementPaths = {
  '/api/improvement/status': {
    get: {
      tags: ['system'],
      summary: '改进闭环状态（harness policy + 台账汇总）',
      responses: {
        200: jsonOk(
          { description: '{ state, ledger }' },
          { $ref: '#/components/schemas/ImprovementStatus' },
        ),
      },
    },
  },
  '/api/improvement/run': {
    post: {
      tags: ['system'],
      summary: '手动跑一轮改进（dryRun=true 时只评估不落盘）',
      requestBody: jsonBody({
        type: 'object',
        properties: { dryRun: { type: 'boolean' } },
      }),
      responses: {
        200: jsonOk(
          { description: '本轮改进结果（候选、采纳与否、配对统计护栏）' },
          { $ref: '#/components/schemas/ImprovementRunResult' },
        ),
        429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
      },
    },
  },
  '/api/improvement/history': {
    get: {
      tags: ['system'],
      summary: '改进轮次历史（倒序）',
      parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } }],
      responses: {
        200: jsonOk(
          { description: '{ items }（limit 上限 200）' },
          {
            type: 'object',
            properties: {
              limit: { type: 'number', description: '实际生效的条数上限（>200 会被夹到 200）' },
              items: {
                type: 'array',
                description: '改进轮次记录（按 createdAt 倒序）',
                items: { $ref: '#/components/schemas/ImprovementRecord' },
              },
            },
            required: ['limit', 'items'],
          },
        ),
      },
    },
  },
  '/api/improvement/scheduler/start': {
    post: {
      tags: ['system'],
      summary: '启动改进闭环的周期调度（无人值守）',
      description: 'intervalHours 未传时回落 harness policy 的默认间隔。',
      requestBody: jsonBody({
        type: 'object',
        properties: { intervalHours: { type: 'number' } },
      }),
      responses: {
        200: jsonOk(
          { description: '调度已启动（含下次运行时间）' },
          {
            type: 'object',
            properties: {
              started: {
                type: 'boolean',
                description:
                  '是否真的注册了定时器；env 显式关闭（IMPROVEMENT_INTERVAL_HOURS=0）且未传 intervalHours 时路由回 400，因此 200 下恒为 true',
              },
              scheduler: {
                oneOf: [{ $ref: '#/components/schemas/ImprovementLoopState' }, { type: 'null' }],
                description: '调度状态；started=false 时为 null',
              },
            },
            required: ['started', 'scheduler'],
          },
        ),
        429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
      },
    },
  },
  '/api/improvement/scheduler/stop': {
    post: {
      tags: ['system'],
      summary: '停止改进闭环的周期调度',
      responses: {
        200: jsonOk(
          { description: '调度已停止' },
          {
            type: 'object',
            properties: {
              stopped: {
                type: 'boolean',
                description: '恒为 true（未在运行也回 true，属幂等停止）',
              },
              scheduler: {
                type: 'null',
                description: '停止后恒为 null（不假装还有调度器在跑）',
              },
            },
            required: ['stopped', 'scheduler'],
          },
        ),
        429: errorResponse('触发限流（写操作默认每分钟 10 次）'),
      },
    },
  },
};
