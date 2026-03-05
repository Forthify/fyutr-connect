/**
 * Response utility functions for consistent API responses
 * All responses follow the format:
 * {
 *   success: boolean,
 *   data: T | null,
 *   error: { code: ErrorCode, message: string, details?: unknown } | null
 * }
 */

/**
 * Common error codes used across the application
 */

import { Context } from "hono";
import { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * Common error codes used across the application
 */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "ALREADY_EXISTS"
  | "RATE_LIMIT_EXCEEDED"
  | "INTERNAL_SERVER_ERROR"
  | "SERVICE_UNAVAILABLE"
  | "BAD_REQUEST"
  | "METHOD_NOT_ALLOWED"
  | "ALREADY_MEMBER"
  | "INVALID_CREDENTIALS"
  | "TOKEN_EXPIRED"
  | "INVALID_TOKEN"
  | "EMAIL_TAKEN"
  | "USERNAME_TAKEN"
  | "INVALID_INVITE"
  | "INVITE_EXPIRED"
  | "TOURNAMENT_NOT_FOUND"
  | "ORGANIZATION_NOT_FOUND"
  | "PARTICIPANT_NOT_FOUND"
  | "MATCH_NOT_FOUND"
  | "PLAYER_NOT_FOUND"
  | "INVALID_SCORE"
  | "INVALID_STATUS"
  | "INVALID_ROLE"
  | "INVALID_PERMISSION"
  | "INVALID_OPERATION"
  | "DATABASE_ERROR"
  | "NETWORK_ERROR"
  | "FILE_TOO_LARGE"
  | "INVALID_FILE_TYPE"
  | "UPLOAD_FAILED"
  | "DELETE_FAILED"
  | "UPDATE_FAILED"
  | "CREATE_FAILED"
  | "FETCH_FAILED"
  | "PRIVACY_BLOCKED";

/**
 * Success responses
 */

export function success<T>(c: Context, data: T) {
  return c.json(
    {
      success: true,
      data,
      error: null,
    },
    200,
  );
}

export function created<T>(c: Context, data: T) {
  return c.json(
    {
      success: true,
      data,
      error: null,
    },
    201,
  );
}

export function noContent(c: Context) {
  return c.body(null, 204);
}

/**
 * Error responses
 */

export function fail(
  c: Context,
  code: ErrorCode,
  message: string,
  status: ContentfulStatusCode = 400,
  error?: unknown,
) {
  // console.error(error);

  const errorResponse: ApiError = {
    code,
    message,
    ...(error !== undefined && { details: error }),
  };

  return c.json(
    {
      success: false,
      data: null,
      error: errorResponse,
    },
    status,
  );
}

export function badRequest(c: Context, message = "Bad Request") {
  return fail(c, "BAD_REQUEST", message, 400);
}

export function unauthorized(c: Context, message = "Unauthorized") {
  return fail(c, "AUTH_REQUIRED", message, 401);
}

export function forbidden(c: Context, message = "Forbidden") {
  return fail(c, "FORBIDDEN", message, 403);
}

export function notFound(c: Context, message = "Not Found") {
  return fail(c, "NOT_FOUND", message, 404);
}

export function conflict(c: Context, message = "Conflict") {
  return fail(c, "CONFLICT", message, 409);
}

export function internalServerError(
  c: Context,
  message = "Internal Server Error",
  error?: unknown,
) {
  return fail(c, "INTERNAL_SERVER_ERROR", message, 500, error);
}

/**
 * Type definitions
 */

export interface ApiResponse<T> {
  success: boolean;
  data: T | null;
  error: ApiError | null;
}

export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: unknown;
}
