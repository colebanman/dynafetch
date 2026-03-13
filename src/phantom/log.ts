const enabled = process.env.DYNAFETCH_DEBUG === "1";

export const log = enabled ? console.log.bind(console) : () => {};
export const warn = enabled ? console.warn.bind(console) : () => {};
export const error = console.error.bind(console);
