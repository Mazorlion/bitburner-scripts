import {
	log, getFilePath, getConfiguration, instanceCount, getNsDataThroughFile, runCommand, waitForProcessToComplete,
	getActiveSourceFiles, tryGetBitNodeMultipliers, getStocksValue,
	formatMoney, formatDuration
} from './helpers.js'

/** Helper to launch a script and log whether if it succeeded or failed
 * @param {NS} ns */
function launchScriptHelper(ns, baseScriptName, args = [], convertFileName = true) {
	ns.tail(); // If we're going to be launching scripts, show our tail window so that we can easily be killed if the user wants to interrupt.
	const pid = ns.run(convertFileName ? getFilePath(baseScriptName) : baseScriptName, 1, ...args);
	if (!pid)
		log(ns, `ERROR: Failed to launch ${baseScriptName} with args: [${args.join(", ")}]`, true, 'error');
	else
		log(ns, `INFO: Launched ${baseScriptName} (pid: ${pid}) with args: [${args.join(", ")}]`, true, 'info');
	return pid;
}

/** @param {NS} ns */
export async function main(ns) {
	const player = await getNsDataThroughFile(ns, 'ns.getPlayer()', '/Temp/getPlayer.txt');
	const strServerIncomeInfo = ns.read('/Temp/analyze-hack.txt');	// HACK: Steal this file that Daemon also relies on
	if (strServerIncomeInfo) {
		const incomeByServer = JSON.parse(strServerIncomeInfo);
		const dictServerHackReqs = await getNsDataThroughFile(ns, 'Object.fromEntries(ns.args.map(server => [server, ns.getServerRequiredHackingLevel(server)]))',
			'/Temp/servers-hack-req.txt', incomeByServer.map(s => s.hostname));
		const [bestServer, gain] = incomeByServer.filter(s => dictServerHackReqs[s.hostname] <= player.hacking)
			.reduce(([bestServer, bestIncome], target) => target.gainRate > bestIncome ? [target.hostname, target.gainRate] : [bestServer, bestIncome], [null, 0]);
		//ns.getServerRequiredHackingLevel
		log(ns, `Identified that the best hack income server is ${bestServer} worth ${formatMoney(gain)}/sec.`)
		launchScriptHelper(ns, 'spend-hacknet-hashes.js',
			["--liquidate", "--spend-on", "Increase_Maximum_Money", "--spend-on", "Reduce_Minimum_Security", "--spend-on-server", bestServer]);
	}
}