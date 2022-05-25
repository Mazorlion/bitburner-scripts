export function calculateGrowGain(ns, host, threads, cores, opts) {
    if (threads === void 0) { threads = 1; }
    if (cores === void 0) { cores = 1; }
    if (opts === void 0) { opts = {}; }
    threads = Math.max(Math.floor(threads), 0);
    var moneyMax = ns.getServerMaxMoney(host);
    var _a = opts.moneyAvailable, moneyAvailable = _a === void 0 ? ns.getServerMoneyAvailable(host) : _a;
    var rate = growPercent(ns, host, threads, cores, opts);
    return Math.min(moneyMax, rate * (moneyAvailable + threads)) - moneyAvailable;
}
/** @param gain money to be added to the server after grow */
export function calculateGrowThreads(ns, host, gain, cores, opts) {
    if (cores === void 0) { cores = 1; }
    if (opts === void 0) { opts = {}; }
    var moneyMax = ns.getServerMaxMoney(host);
    var _a = opts.moneyAvailable, moneyAvailable = _a === void 0 ? ns.getServerMoneyAvailable(host) : _a;
    var money = Math.min(Math.max(moneyAvailable + gain, 0), moneyMax);
    var rate = Math.log(growPercent(ns, host, 1, cores, opts));
    var logX = Math.log(money * rate) + moneyAvailable * rate;
    return Math.max(lambertWLog(logX) / rate - moneyAvailable, 0);
}
function growPercent(ns, host, threads, cores, opts) {
    if (threads === void 0) { threads = 1; }
    if (cores === void 0) { cores = 1; }
    if (opts === void 0) { opts = {}; }
    var _a = opts.ServerGrowthRate, ServerGrowthRate = _a === void 0 ? 1 : _a, _b = opts.hackDifficulty, hackDifficulty = _b === void 0 ? ns.getServerSecurityLevel(host) : _b;
    var growth = ns.getServerGrowth(host) / 100;
    var multiplier = ns.getPlayer().hacking_grow_mult;
    var base = Math.min(1 + 0.03 / hackDifficulty, 1.0035);
    var power = growth * ServerGrowthRate * multiplier * ((cores + 15) / 16);
    return Math.pow(base, (power * threads));
}
/**
 * Lambert W-function for log(x) when k = 0
 * {@link https://gist.github.com/xmodar/baa392fc2bec447d10c2c20bbdcaf687}
 */
function lambertWLog(logX) {
    if (isNaN(logX))
        return NaN;
    var logXE = logX + 1;
    var logY = 0.5 * log1Exp(logXE);
    var logZ = Math.log(log1Exp(logY));
    var logN = log1Exp(0.13938040121300527 + logY);
    var logD = log1Exp(-0.7875514895451805 + logZ);
    var w = -1 + 2.036 * (logN - logD);
    w *= (logXE - Math.log(w)) / (1 + w);
    w *= (logXE - Math.log(w)) / (1 + w);
    w *= (logXE - Math.log(w)) / (1 + w);
    return isNaN(w) ? (logXE < 0 ? 0 : Infinity) : w;
}
var log1Exp = function (x) {
    return x <= 0 ? Math.log(1 + Math.exp(x)) : x + log1Exp(-x);
};
export function getServerGrowthRate(ns, host) {
    var value = ns.growthAnalyze(host, Math.E);
    if (!isFinite(value))
        return NaN;
    return 1 / (value * Math.log(growPercent(ns, host, 1, 1)));
}
