const RESET = "\x1b[0m";
const DIM   = "\x1b[2m";
const BOLD  = "\x1b[1m";

const C = {
  gray:    "\x1b[90m",
  green:   "\x1b[32m",
  yellow:  "\x1b[33m",
  red:     "\x1b[31m",
  cyan:    "\x1b[36m",
  magenta: "\x1b[35m",
  blue:    "\x1b[34m",
  white:   "\x1b[37m",
};

function ts() {
  return `${DIM}${new Date().toLocaleTimeString("ru-RU", { hour12: false })}${RESET}`;
}

function tag(color: string, label: string) {
  return `${color}${BOLD}[${label}]${RESET}`;
}

export const log = {
  info:    (msg: string) => console.log(`${ts()} ${tag(C.cyan,    "INFO"   )} ${msg}`),
  ok:      (msg: string) => console.log(`${ts()} ${tag(C.green,   "OK"     )} ${msg}`),
  warn:    (msg: string) => console.log(`${ts()} ${tag(C.yellow,  "WARN"   )} ${msg}`),
  error:   (msg: string) => console.log(`${ts()} ${tag(C.red,     "ERROR"  )} ${msg}`),
  cmd:     (msg: string) => console.log(`${ts()} ${tag(C.magenta, "CMD"    )} ${msg}`),
  cb:      (msg: string) => console.log(`${ts()} ${tag(C.blue,    "BUTTON" )} ${msg}`),
  mail:    (msg: string) => console.log(`${ts()} ${tag(C.yellow,  "MAIL"   )} ${msg}`),
  msg:     (msg: string) => console.log(`${ts()} ${tag(C.gray,    "MSG"    )} ${msg}`),
};
