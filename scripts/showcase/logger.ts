const timestamp = (): string =>
  new Date().toLocaleTimeString(undefined, { hour12: true });

const appendParams = (base: string, params?: Record<string, any>): string => {
  if (!params) return base;

  let result = `${base} |`;
  for (const [key, rawValue] of Object.entries(params)) {
    const value =
      typeof rawValue === "object" ? JSON.stringify(rawValue) : rawValue;
    result += ` ${key}=${value}\n`;
  }
  return result;
};

export const logger = {
  info: (message: string, params?: Record<string, any>) => {
    console.log(appendParams(`${timestamp()} info] ${message}`, params));
  },
  warn: (message: string, params?: Record<string, any>) => {
    console.warn(appendParams(`${timestamp()} warn] ${message}`, params));
  },
  error: (message: string, params?: Record<string, any>, stack?: any) => {
    let result = appendParams(`${timestamp()} error] ${message}`, params);
    if (stack) result += ` | stack=${stack}`;
    console.error(result);
  },
};
