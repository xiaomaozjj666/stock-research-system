import {
  autonomousStateProperties,
  coverageProperties,
  errorResponse,
  jsonBody,
  jsonOk,
} from '../shared.js';

export const autonomousPaths = {
  '/api/autonomous/start': {
    post: {
      tags: ['autonomous'],
      summary: '启动自治监控循环',
      description: '连续失败指数退避（封顶 8 倍），连续失败 10 次自动停止。',
      requestBody: jsonBody({
        type: 'object',
        properties: {
          intervalMs: {
            type: 'number',
            minimum: 30000,
            maximum: 86400000,
            description: '轮询间隔，夹紧到 [30 秒, 24 小时]，默认 5 分钟',
          },
        },
      }),
      responses: {
        200: jsonOk(
          { description: 'started + 循环状态' },
          {
            type: 'object',
            properties: {
              started: { type: 'boolean', description: '恒为 true（启动成功才走到这行）' },
              ...autonomousStateProperties,
              ...coverageProperties,
            },
            required: [
              'started',
              'running',
              'intervalMs',
              'lastAlertCount',
              'runCount',
              'errorCount',
            ],
          },
        ),
        429: errorResponse('触发限流'),
        500: errorResponse('启动失败'),
      },
    },
  },
  '/api/autonomous/stop': {
    post: {
      tags: ['autonomous'],
      summary: '停止自治监控循环',
      responses: {
        200: jsonOk(
          { description: 'stopped + 最近一次预警' },
          {
            type: 'object',
            properties: {
              stopped: {
                type: 'boolean',
                description: '恒为 true（未在运行也回 true，属幂等停止）',
              },
              lastAlerts: {
                type: 'array',
                description: '最近一轮检出的预警（进程内缓存，重启即空；从未预警过时为空数组）',
                items: { $ref: '#/components/schemas/WatchlistAlert' },
              },
            },
            required: ['stopped', 'lastAlerts'],
          },
        ),
      },
    },
  },
  '/api/autonomous/status': {
    get: {
      tags: ['autonomous'],
      summary: '自治循环状态',
      responses: {
        200: jsonOk(
          {
            description: 'running/intervalMs/runCount/errorCount 等；未运行时 {running:false}',
          },
          {
            type: 'object',
            properties: {
              ...autonomousStateProperties,
              ...coverageProperties,
            },
            // 未在运行时路由只回 { running: false }，其余字段全部缺省
            required: ['running'],
          },
        ),
      },
    },
  },
};
