export const logger = {
  info: (message: string, params?: Record<string, any>) => {
    let result = `${new Date().toLocaleTimeString({ hour12: true })} info] ${message}`;

    if (params) {
      result += " |";
      for (const entry of Object.entries(params)) {
        let value = entry[1];
        if (typeof value === "object") {
          value = JSON.stringify(value);
        }
        result += ` ${entry[0]}=${value}\n`;
      }
    }
    console.log(result);
  },
  error: (message: string, params?: Record<string, any>, stack?: any) => {
    let result = `${new Date().toLocaleTimeString({ hour12: true })} error] ${message}`;

    if (params) {
      result += ` |`;
      for (const entry of Object.entries(params)) {
        let value = entry[1];
        if (typeof value === "object") {
          value = JSON.stringify(value);
        }
        result += ` ${entry[0]}=${value}\n`;
      }
    }

    if (stack) {
      result += ` | stack=${stack}`;
    }
    console.error(result);
  },
};
