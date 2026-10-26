/**
 * M03 统一错误对象。
 * 对外只暴露稳定的 error code、可读中文 message 与必要 details，
 * 不暴露文件路径、内部堆栈或任何密钥信息。
 */
export class ApiError extends Error {
  constructor(status, code, message, details, options = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.allow = options.allow;
  }
}

export function toApiError(error) {
  if (error instanceof ApiError) return error;
  return new ApiError(500, 'INTERNAL_ERROR', '服务内部错误');
}
