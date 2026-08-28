import type { Hono } from 'hono';

export type TestResponseBody = unknown;

export interface TestResponse<T = TestResponseBody> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: T;
  text: string;
}

type ResponseStream = {
  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'end', listener: () => void): void;
};

export type ResponseParser<T> = (
  stream: ResponseStream,
  callback: (error: Error | null, value?: T) => void,
) => void;

type RequestBody = BodyInit | undefined;

const responseHeaders = (headers: Headers): Record<string, string | string[] | undefined> => {
  const result: Record<string, string | string[] | undefined> = {};
  const setCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();

  headers.forEach((value, key) => {
    result[key] = key === 'set-cookie' && setCookie?.length ? setCookie : value;
  });

  if (setCookie?.length) result['set-cookie'] = setCookie;
  return result;
};

const parseResponse = async <T>(response: Response, parser?: ResponseParser<T>): Promise<T> => {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (parser) {
    return await new Promise<T>((resolve, reject) => {
      let onData: ((chunk: Buffer) => void) | undefined;
      let onEnd: (() => void) | undefined;
      const stream = {
        on(event: 'data' | 'end', listener: ((chunk: Buffer) => void) | (() => void)) {
          if (event === 'data') onData = listener as (chunk: Buffer) => void;
          if (event === 'end') onEnd = listener as () => void;
        },
      };
      parser(stream, (error, value) => (error ? reject(error) : resolve(value as T)));
      onData?.(bytes);
      onEnd?.();
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return (bytes.length ? JSON.parse(bytes.toString('utf8')) : undefined) as T;
  }
  return bytes as T;
};

export class HttpRequest<T = TestResponseBody> implements PromiseLike<TestResponse<T>> {
  private readonly headers = new Headers();
  private body: RequestBody;
  private parser?: ResponseParser<T>;
  private expectedStatus?: number;
  private assertion?: (response: TestResponse<T>) => void;

  public constructor(
    private readonly app: Hono,
    private readonly method: string,
    private readonly path: string,
  ) {}

  public set(name: string, value: string | string[] | undefined): this {
    if (value === undefined) throw new Error(`Cannot set missing header value for ${name}`);
    this.headers.set(name, Array.isArray(value) ? value.join('; ') : value);
    return this;
  }

  public send(body: unknown): this {
    if (body instanceof ArrayBuffer || body instanceof Blob || body instanceof FormData || typeof body === 'string') {
      this.body = body as BodyInit;
    } else if (body instanceof Uint8Array) {
      this.body = body as BodyInit;
    } else {
      this.body = JSON.stringify(body);
      if (!this.headers.has('content-type')) this.headers.set('content-type', 'application/json');
    }
    return this;
  }

  public attach(field: string, data: Buffer | Blob, filename?: string): this {
    const form = this.body instanceof FormData ? this.body : new FormData();
    const value = data instanceof Blob ? data : new Blob([new Uint8Array(data)]);
    form.append(field, value, filename);
    this.body = form;
    return this;
  }

  public buffer(_enabled: boolean): this {
    return this;
  }

  public parse(parser: ResponseParser<T>): this {
    this.parser = parser;
    return this;
  }

  public expect(expected: number): this;
  public expect(assertion: (response: TestResponse<T>) => void): this;
  public expect(expectedOrAssertion: number | ((response: TestResponse<T>) => void)): this {
    if (typeof expectedOrAssertion === 'number') this.expectedStatus = expectedOrAssertion;
    else this.assertion = expectedOrAssertion;
    return this;
  }

  private async execute(): Promise<TestResponse<T>> {
    const response = await this.app.request(this.path, {
      method: this.method,
      headers: this.headers,
      body: this.body,
    });
    const body = await parseResponse<T>(response, this.parser);
    const result: TestResponse<T> = {
      status: response.status,
      headers: responseHeaders(response.headers),
      body,
      text: typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : JSON.stringify(body),
    };

    if (this.expectedStatus !== undefined && response.status !== this.expectedStatus) {
      throw new Error(`Expected status ${this.expectedStatus}, received ${response.status}`);
    }
    this.assertion?.(result);
    return result;
  }

  public then<TResult1 = TestResponse<T>, TResult2 = never>(
    onFulfilled?: ((value: TestResponse<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onFulfilled, onRejected);
  }
}

export interface HttpRequestFactory {
  get<T = TestResponseBody>(path: string): HttpRequest<T>;
  options<T = TestResponseBody>(path: string): HttpRequest<T>;
  post<T = TestResponseBody>(path: string): HttpRequest<T>;
  put<T = TestResponseBody>(path: string): HttpRequest<T>;
  patch<T = TestResponseBody>(path: string): HttpRequest<T>;
  delete<T = TestResponseBody>(path: string): HttpRequest<T>;
}

export const request = (app: Hono): HttpRequestFactory => {
  const create = (method: string) => <T = TestResponseBody>(path: string) =>
    new HttpRequest<T>(app, method, path);
  return {
    get: create('GET'),
    options: create('OPTIONS'),
    post: create('POST'),
    put: create('PUT'),
    patch: create('PATCH'),
    delete: create('DELETE'),
  };
};
