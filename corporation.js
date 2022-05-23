import {
    formatMoney, formatNumberShort, getActiveSourceFiles, getConfiguration, getFilePath, instanceCount, log
} from './helpers.js';

let options = null; // The options used at construction time
const argsSchema = [ // The set of all command line arguments
    ['verbose', true], // Should the script print debug logging.
    ['skip-all-setup', false], // Should we just jump straight to the loop?
    [`max-office-size`, 1000], // Cap size of offices for game performance.
    [`simulate-investor-trick`, false],
    [`simulate-tobacco-investor-trick`, false],
    [`disable-spending-hashes`, false], // If true, will not start spend-hashes.
    [`only-do-price-discovery`, false],
    [`only-force-assign-employees`, false],
];
export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

// args
let verbose;
let maxOfficeSize;
let disableHashes;

let activeSourceFiles_;

const kCorpName = `Hemmy`;
const kAgricultureDivision = `Ag`;
const kTobaccoDivision = `Tobacco`;
const kCities = [`Aevum`, `Chongqing`, `Sector-12`, `New Tokyo`, `Ishima`, `Volhaven`];
const kProductDevCity = `Aevum`;

// Convenience Aliases.
/**
 * @type {NS}
 */
let ns_; // ns
/**
 * @type {Corporation}
 */
let corp_; // ns.corporation
/**
 * 
 * @returns {CorporationInfo}
 */
let corp = () => corp_.getCorporation();
/**
 * 
 * @returns {Number} Currently available corporation funds.
 */
let funds = () => corp().funds;
/**
 * 
 * @param {String} division 
 * @returns {Division}
 */
let getDivision = (division) => corp_.getDivision(division);
/**
 * 
 * @param {String} division 
 * @returns {Product[]}
 */
let getProducts = (division) => getDivision(division).products
        .map(product => corp_.getProduct(kTobaccoDivision, product));
/**
 * 
 * @param {String} division 
 * @param {String} city 
 * @returns {Office}
 */
let getOffice = (division, city) => corp_.getOffice(division, city);
/**
 * 
 * @param {*} division 
 * @param {*} city 
 * @returns {Number}
 */
let numEmployees = (division, city) => getOffice(division, city).employees.length;

/**
 * 
 * @param {Boolean} waitForNext If currently in a START state, will sleep until the next one if true.
 */
async function sleepWhileNotInStartState(waitForNext = false) {
    let corporation = corp();
    if (waitForNext) {
        while (corporation.state === 'START') {
            await ns_.sleep(50);
            corporation = corp();
        }
    }
    let lastState = 'Unknown';
    while (corporation.state !== 'START') {
        if (verbose && corporation.state !== lastState) {
            // log(ns_, `Waiting for corporation to move into the 'START' status. Currently: '${myCorporation.state}'.`);
            lastState = corporation.state;
        }
        await ns_.sleep(50); // Better keep the sleep short, in case we're in catch-up mode.
        corporation = corp();
    }
}

/**
 * 
 * @param {Material} material Material to purchase
 * @param {Number} desiredValue Desired end value
 * @returns {Number} Per-second rate to purchase to achieve `desiredValue`
 */
function calculateOneTickPurchaseRate(material, desiredValue) {
    const currentAmount = material.qty;
    const secondsPerTick = 10;
    return (desiredValue - currentAmount) / 10;
}

async function purchaseInOneTick(items) {
    // Wait for START, but if we're already in one that's fine.
    await sleepWhileNotInStartState(false);
    const cityItemPairs = kCities.reduce(
        (res, city) => res.concat(
            items.map((item) => ({ city: city, item: item }))), []);
    let needPurchase = false;
    cityItemPairs.forEach(pair => {
        const city = pair.city;
        const item = pair.item;
        const targetRate = calculateOneTickPurchaseRate(corp_.getMaterial(kAgricultureDivision, city, item.name), item.targetQuantity);
        if (targetRate <= 0) {
            // log(ns_, `Not purchasing ${item.name} because we already have sufficient in the warehouse.`);
            return;
        }
        needPurchase = true;
        log(ns_, `Purchasing ${item.name} in ${city} at ${targetRate}.`)
        corp_.buyMaterial(kAgricultureDivision, city, item.name, targetRate);
    });
    if (!needPurchase)
        return;
    // Wait for purchases to be made by waiting for the next START.
    await sleepWhileNotInStartState(true);
    cityItemPairs.forEach(pair => {
        const city = pair.city;
        const item = pair.item;
        corp_.buyMaterial(kAgricultureDivision, city, item.name, 0);
        // Check the outcome.
        const endingQuantity = corp_.getMaterial(kAgricultureDivision, city, item.name).qty;
        if (endingQuantity !== item.targetQuantity) {
            log(ns_, `Expected ${item.name} to finish with ${formatNumberShort(item.targetQuantity)} but ended with ${formatNumberShort(endingQuantity)} in ${city}.`);
        }
    });
}

async function doPriceDiscovery() {
    if (verbose) log(ns_, ``);
    // TODO: Don't log anything if we have Market-TA.II.
    if (verbose) log(ns_, `Doing price discovery for products.`);
    const division = getDivision(kTobaccoDivision);
    // If we have Market-TA.II researched, just let that work.
    let hasMarketTA2 = corp_.hasResearched(division.name, 'Market-TA.II');
    if (hasMarketTA2) {
        for (const city of division.cities) {
            // Default prices
            division.products.forEach((product) => corp_.sellProduct(division.name, city, product, 'MAX', 'MP', false));
            // Turn on automation.
            division.products.forEach((product) => corp_.setProductMarketTA2(division.name, product, true));
        }
        // No need to do any other price discovery on this division.
        return;
    }

    // Go through each product, and see if the price needs to be adjusted. We can only
    // adjust the price on a per-product basis (desipe the UI letting you do it
    // manually, the API is busted.)
    let prevProductMultiplier = 1.0;
    for (const productName of division.products) {
        const product = corp_.getProduct(division.name, productName);
        if (product.developmentProgress < 100) continue;
        let sPrice = product.sCost;
        // sPrice ought to be of the form 'MP * 123.45'. If not, we should use the price of the last product we calculated.
        let lastPriceMultiplier = prevProductMultiplier;
        try {
            // @ts-ignore
            let sMult = sPrice.split('*')[1];
            lastPriceMultiplier = Number.parseFloat(sMult);
        } catch { }
        let votes = [];
        for (const city of division.cities) {
            // Each city is going to "vote" for how they want the price to be manipulated.
            let qty = product.cityData[city][0];
            let produced = product.cityData[city][1];
            let sold = product.cityData[city][2];
            // if (verbose) log(ns_, `${division.name}/${city}:${product.name} (qty, prod, sold): ` + product.cityData[city].map((n) => nf(n)));

            if (produced == sold && qty == 0) {
                // We sold every item we produced. Vote to double the price.
                votes.push(lastPriceMultiplier * 2);
            }
            // If we've accumulated a big stockpile, reduce our prices.
            else if (qty > produced * 100) {
                votes.push(lastPriceMultiplier * 0.9);
            } else if (qty > produced * 40) {
                votes.push(lastPriceMultiplier * 0.95);
            } else if (qty > produced * 20) {
                votes.push(lastPriceMultiplier * 0.98);
            }
            // Our stock levels must be good. If we sold less than production, then our price is probably high
            else if (sold < produced) {
                let newMultiplier = lastPriceMultiplier;
                if (sold <= produced * 0.5) {
                    newMultiplier *= 0.75; // Our price is very high.
                } else if (sold <= produced * 0.9) {
                    newMultiplier *= 0.95; // Our price is a bit high.
                } else {
                    newMultiplier *= 0.99; // Our price is just barely high
                }
                votes.push(newMultiplier);
            }
            // If we sold more than production, then our price is probably low.
            else if (produced < sold) {
                let newMultiplier = lastPriceMultiplier;
                if (sold >= produced * 2) {
                    newMultiplier *= 2; // We sold way too much. Double the price.
                } else if (sold >= produced * 1.33) {
                    newMultiplier *= 1.05; // We sold a bit too much. Bring the price up a bit.
                } else {
                    newMultiplier *= 1.01;
                }
                votes.push(newMultiplier);
            }
        } // end for-cities
        // All of the cities have voted. Use the lowest price that the cities have asked for.
        votes.sort((a, b) => a - b);
        let newMultiplier = votes[0];
        let newPrice = `MP*${newMultiplier.toFixed(3)}`;
        if (verbose) log(ns_, `    Votes: ${votes.map((n) => formatNumberShort(n)).join(', ')}.`);
        if (verbose) log(ns_, `    Adjusting '${product.name}' price from ${sPrice} to ${newPrice}.`);
        corp_.sellProduct(division.name, kProductDevCity, product.name, 'MAX', newPrice, true);
        prevProductMultiplier = newMultiplier;
    } // end for-products
    if (verbose) log(ns_, ``);
}

async function waitForFunds(targetFunction, reason, sleepDuration = 15000) {
    while (targetFunction() > funds()) {
        log(ns_, `Waiting for money to ${reason}. Have: ${formatMoney(funds())}, Need: ${formatMoney(targetFunction())}`);
        await ns_.sleep(sleepDuration);
    }
}

async function waitForInvestmentOffer(minOffer, sleepDuration = 15000) {
    while (corp_.getInvestmentOffer().funds < minOffer) {
        log(ns_, `Waiting for investment offer to be over ${formatMoney(minOffer)}. Currently: ${formatMoney(corp_.getInvestmentOffer().funds)}`);
        await ns_.sleep(sleepDuration);
    }
    log(ns_, `Accepting investment offer for ${formatMoney(corp_.getInvestmentOffer().funds)}`, true, `success`);
    corp_.acceptInvestmentOffer();
}

/**
 * 
 * @param {String} division 
 * @param {String} amount
 */
function setSelling(division, amount) {
    if (division === kAgricultureDivision) {
        for (const city of kCities) {
            // Only do these two for now.
            for (const material of [`Food`, `Plants`])
                corp_.sellMaterial(division, city, material, amount, `MP`); 
        }
    } else if (division === kTobaccoDivision) {
        for (const product of getProducts(kTobaccoDivision)) {
            // TODO: Consider reducing `sCost` to sell more in one cycle.
            corp_.sellProduct(division, kProductDevCity, product.name, amount, String(product.sCost), true);
        }
    } else {
        log(ns_, `Unknown division ${division}. change selling status.`);
        return;
    }
}

/**
 * 
 * @param {String} division 
 * @param {boolean} acceptInvestment If true, will actually accept a large enough investment.
 */
async function trickInvest(division, acceptInvestment = true) {
    // TODO: Consider doing this for all divisions at once? Maybe not worthwhile as Ag ends up being nearly nothing.
    log(ns_, `Preparing to trick investors.`);
    // Wait for happy employees to maximize productivity. Tobacco will be losing money if all products are unset though.
    if (division === kAgricultureDivision)
        await waitForHappy(division);

    // Grab the initial offer before we mess with our sales.
	const initialInvestFunds = corp_.getInvestmentOffer().funds;
    const initialSharePrice = corp().sharePrice;
    log(ns_, `Initial investment offer:${formatMoney(initialInvestFunds)}`);
    // Stop selling.
    setSelling(division, `0`);

	for (const city of kCities) {
		// put all employees into production to produce as fast as possible 
		const employees = numEmployees(division, city);
		
		await corp_.setAutoJobAssignment(division, city, "Management", 0);
		await corp_.setAutoJobAssignment(division, city, "Research & Development", 0);
		await corp_.setAutoJobAssignment(division, city, "Business", 0);
        if (division === kAgricultureDivision) {
            // TODO: It's possible setting operations here is fine and just engineer before we sell.
            await corp_.setAutoJobAssignment(division, city, "Operations", 0);
            await corp_.setAutoJobAssignment(division, city, "Engineer", employees);
        } else {
            await corp_.setAutoJobAssignment(division, city, "Engineer", 0);
            await corp_.setAutoJobAssignment(division, city, "Operations", employees);
        }
    }

    // TODO: Maybe increase warehouse sizes.
    log(ns_, `Waiting for warehouses to fill up`);
	let allWarehousesFull = false;
	while (!allWarehousesFull) {
		allWarehousesFull = true;
		for (const city of kCities) {
			if (corp_.getWarehouse(division, city).sizeUsed <= (0.98 * corp_.getWarehouse(division, city).size)) {
                if (verbose)
                    log(ns_, `Waiting for ${city} to be full. Currently at: ` +
                        `${((corp_.getWarehouse(division, city).sizeUsed / (0.98 * corp_.getWarehouse(division, city).size)) * 100).toFixed(2)}%`);
				allWarehousesFull = false;
				break;
			}
		}
		await ns_.sleep(5000);
	}

	log(ns_, `Warehouses are full; reassign employees for profit cycle.`);
    // TODO: Theoretically waiting for us to finish production then move all to business is probably correct.
	for (const city of kCities) {
		// put all employees into business to sell as much as possible 
		const employees = numEmployees(division, city);
        // For material based (agriculture), use some engineers. Otherwise all business.
        const business = division === kAgricultureDivision ? Math.floor(employees/3) : employees ;
        await corp_.setAutoJobAssignment(division, city, "Operations", 0);
		await corp_.setAutoJobAssignment(division, city, "Engineer", employees - business);
		await corp_.setAutoJobAssignment(division, city, "Business", business);
	}

    // Resume selling.
    log(ns_, `Employees assigned, waiting for START then we'll begin selling.`);
    await sleepWhileNotInStartState(true);
    setSelling(division, `MAX`);

    const kAcceptableFundsMultiplier = 6;
	while (corp_.getInvestmentOffer().funds < (kAcceptableFundsMultiplier * initialInvestFunds)) {
		await ns_.sleep(200);
        if (verbose) {
            log(ns_, `Waiting for funds to peak. Current:${formatMoney(corp_.getInvestmentOffer().funds)} ` + 
                `Target: ${formatMoney(initialInvestFunds * kAcceptableFundsMultiplier)}`)                
            log(ns_, `Waiting. Share price change: ${formatMoney(initialSharePrice)} -> ${formatMoney(corp().sharePrice)}`);
        }
	}

    const investmentOffer = corp_.getInvestmentOffer();
    log(ns_, `Investment offer for ${((investmentOffer.shares / corp().totalShares)*100).toFixed(2)}% shares: ${formatMoney(investmentOffer.funds)}`);
    log(ns_, `Share price change: ${formatMoney(initialSharePrice)} -> ${formatMoney(corp().sharePrice)}`);
    // Accept the offer.
    if (acceptInvestment)
        corp_.acceptInvestmentOffer();
    // TODO: Consider doing it with shares just on the first round.
	// corp_.goPublic(800e6);

	for (const city of kCities) {
        // Force rebalance employees.
        await maybeAutoAssignEmployees(division, city, true);
	}
}

async function maybeExpandCity(division, city, wait = true) {
    if (getDivision(division).cities.includes(city))
        return;
    if (wait)
        await waitForFunds(() => corp_.getExpandCityCost(), `expand to ${city}`);
    else if (funds() < corp_.getExpandCityCost()) 
        return false;
    corp_.expandCity(division, city);
    return true;
}

function setSmartSupply(division) {
    for (const city of kCities) {
        if (corp_.hasWarehouse(division, city))
            corp_.setSmartSupply(division, city, true);
    }
}

// Fills employees in `city` up to `office.size`.
function fillEmployees(division, city) {
    while (numEmployees(division, city) < getOffice(division, city).size) {
        corp_.hireEmployee(division, city);
    }
}

/**
 * 
 * @param {String} division 
 * @param {String} city 
 * @param {Boolean} forceAssign Should we force-reassign even if all employees have jobs
 * @returns 
 */
async function maybeAutoAssignEmployees(division, city, forceAssign = false) {
    const employeeJobs = getOffice(division, city).employeeJobs;
    const assigned = [`Operations`, `Engineer`, `Business`, `Management`, `Research & Development`].reduce((sum, job) => sum + employeeJobs[job]);
    const employees = numEmployees(division, city);
    // All employees working, nothing to do.
    // @ts-ignore
    if (!forceAssign && assigned === employees && employeeJobs.Unassigned === 0)
        return;

    if (forceAssign) {
        // If we're force reassigning, first clear everything so the below logic works.
        for (const job of [`Operations`, `Engineer`, `Business`, `Management`, `Research & Development`]) {
            await corp_.setAutoJobAssignment(division, city, job, 0);
        }
    }

    // Special case 9
    if (employees === 9) {
        for (const job of [`Operations`, `Engineer`, `Management`, `Research & Development`]) {
            await corp_.setAutoJobAssignment(division, city, job, 2);
        }
        await corp_.setAutoJobAssignment(division, city, `Business`, 1);
        return;
    }

    // Evenly balance employees otherwise, preferring ones earlier in this list.
    const jobs = [`Operations`, `Engineer`, `Business`, `Management`, `Research & Development`];
    const baseEmployees = Math.floor(employees / jobs.length);
    for (let i = 0; i < jobs.length; ++i) {
        const adjustment = i < employees % jobs.length ? 1 : 0;
        await corp_.setAutoJobAssignment(division, city, jobs[i], baseEmployees + adjustment);
    }
}

// Returns true if an upgrade happened, false otherwise.
async function tryUpgradeOfficeToSize(division, city, targetSize, wait = true) {
    const startingSize = getOffice(division, city).size;
    if (startingSize >= targetSize)
        return false;

    const increment = targetSize - startingSize;

    const costFunction = () => corp_.getOfficeSizeUpgradeCost(division, city, increment);
    const reason = `upgrade ${city} by ${increment} to ${targetSize}`
    if (wait)
        await waitForFunds(costFunction, reason);
    else if (funds() < costFunction()) {        
        log(ns_, `Cannot ${reason}; insufficient funds.`);
        return false;
    }

    log(ns_, `Upgrading ${city} by ${increment} to ${targetSize}.`);
    corp_.upgradeOfficeSize(division, city, increment);
    return true;
}

const defaultUpgradeOfficeSettings = { assignEmployees: true, waitForFunds: true, returnIfNoOfficeUpgrade: false };
/**
 * 
 * @param {String} division 
 * @param {String} city 
 * @param {Number} targetSize 
 * @param {*} upgradeSettings 
 * @returns 
 */
async function tryUpsizeHireAssignOffice(division, city, targetSize, upgradeSettings = defaultUpgradeOfficeSettings) {
    await maybeExpandCity(division, city, upgradeSettings.waitForFunds);
    if (numEmployees(division, city) >= targetSize)
        return false;
    let sizeChangeHappened = await tryUpgradeOfficeToSize(division, city, targetSize, upgradeSettings.waitForFunds);
    if (!sizeChangeHappened && upgradeSettings.returnIfNoOfficeUpgrade)
        return false;
    fillEmployees(division, city);
    if (upgradeSettings.assignEmployees)
        await maybeAutoAssignEmployees(division, city);
    return true;
}

async function tryUpsizeHireAssignAllOfficesToSize(division, targetSize) {
    for (const city of kCities) {
        await tryUpsizeHireAssignOffice(division, city, targetSize);
    }
}

async function tryUpgradeWarehouseToSize(division, city, targetSize) {
    if (!corp_.hasWarehouse(division, city)) {
        await waitForFunds(() => corp_.getPurchaseWarehouseCost(), `purchase a warehouse in ${city}`);
        corp_.purchaseWarehouse(division, city);
    }

    const costFunction = () => corp_.getUpgradeWarehouseCost(division, city);
    while (corp_.getWarehouse(division, city).size < targetSize) {
        const reason = `upgrade warehouse in ${city} from ${corp_.getWarehouse(division, city).size}`;
        await waitForFunds(costFunction, reason);
        corp_.upgradeWarehouse(division, city);
    }
}

// If `fundsFraction` < 1 || !`wait`, will purchase if immediately available or else return false.
// Otherwise, waits for funds and returns true when complete.
async function tryUpgradeLevel(upgrade, wait = true, fundsFraction = 1) {
    if (fundsFraction == 1 && wait)
        await waitForFunds(() => corp_.getUpgradeLevelCost(upgrade), `upgrade ${upgrade} to ${corp_.getUpgradeLevel(upgrade) + 1}`);
    else if (funds() * fundsFraction < corp_.getUpgradeLevelCost(upgrade))
        return false;
    corp_.levelUpgrade(upgrade);
    return true;
}

/**
 * 
 * @param {String} upgrade Name of the upgrade whose level to increase.
 * @param {Number} targetLevel Level to which `upgrade` should be upgraded.
 */
async function upgradeToLevel(upgrade, targetLevel) {
    while (corp_.getUpgradeLevel(upgrade) < targetLevel)
        await tryUpgradeLevel(upgrade);
}

async function initialSetup() {
    // Log these functions for ease of information.
    ns_.enableLog(`ALL`);
    // TODO: Double check this.
    try {
        corp();
    } catch (error) {
        if (ns_.getPlayer().money < 160e9) {
            log(ns_, `No corp active, need seed money. Have ${formatMoney(ns_.getPlayer().money)}, want ${formatMoney(160e9)}`);
            return false;
        }
        // while (ns_.getPlayer().money < 160e9) {
        //     log(ns_, `Waiting for corp seed money. Have ${formatMoney(ns_.getPlayer().money)}, want ${formatMoney(160e9)}`);
        //     await ns_.sleep(30000);
        // }
        corp_.createCorporation(kCorpName, true);
    }

    if (!corp_.hasUnlockUpgrade(`Office API`) || !corp_.hasUnlockUpgrade(`Warehouse API`)) {
        log(ns_, `This script requires both Office API and Warehouse API to run (BN 3.3 complete).`);
        return false;
    }

    // Set up Agriculture Division
    // TODO: make sure the name matches what we want.
    if (!corp().divisions.find(division => division.type === `Agriculture`))
        corp_.expandIndustry(`Agriculture`, kAgricultureDivision);

    // Buy smart supply
    if (!corp_.hasUnlockUpgrade(`Smart Supply`))
        corp_.unlockUpgrade(`Smart Supply`);

    await tryUpsizeHireAssignAllOfficesToSize(kAgricultureDivision, 3);
    setSmartSupply(kAgricultureDivision);

    // buy a single Advert
    if (corp_.getHireAdVertCount(kAgricultureDivision) === 0) {
        await waitForFunds(
            () => corp_.getHireAdVertCost(kAgricultureDivision),
            `hire AdVert for Agriculture Division during initial setup`);
        corp_.hireAdVert(kAgricultureDivision);
    }

    for (const city of kCities)
        await tryUpgradeWarehouseToSize(kAgricultureDivision, city, 300);
    // Start selling `Plants` and `Food` for MAX/MP
    kCities.forEach((city) => {
        corp_.sellMaterial(kAgricultureDivision, city, `Plants`, `MAX`, `MP`);
        corp_.sellMaterial(kAgricultureDivision, city, `Food`, `MAX`, `MP`);
    });

    // === First growth round ====
    // (UPGRADES) Purchase two rounds:
    // - FocusWires
    // - Neural Accelerators
    // - Speech Processor Implants
    // - Neuoptimal Nootropic Injector Implants
    // - Smart Factories
    for (const upgrade of [
        `FocusWires`,
        `Neural Accelerators`,
        `Speech Processor Implants`,
        `Nuoptimal Nootropic Injector Implants`,
        `Smart Factories`
    ]) {
        await upgradeToLevel(upgrade, 2);
    }

    // (SUPPORT ITEMS) Purchase via one-tick:
    const firstRoundSupportItems = [
        // - Hardware 12.5/s -> 125
        {
            name: `Hardware`,
            targetQuantity: 125
        },
        // - AI Cores 7.5/s -> 75
        {
            name: `AI Cores`,
            targetQuantity: 75
        },
        // - Real Estate 2700/s -> 27,000
        {
            name: `Real Estate`,
            targetQuantity: 27000
        }
    ];
    ns_.disableLog(`ALL`);
    await purchaseInOneTick(firstRoundSupportItems);
    log(ns_, `First support items purchased for Agriculture`);

    return true;
}

/**
 * Do all employees have enough happiness, energy, and morale?
 * @param {string} division
 * @param {number} lowerLimit - minimum for all stats [0,1]
 * @returns {boolean}
 */
function allEmployeesSatisfied(division = kAgricultureDivision, lowerLimit = 0.99998) {
    let allSatisfied = true;
    for (const city of getDivision(division).cities) {
        let office = getOffice(division, city);
        let employees = office.employees.map((e) => corp_.getEmployee(division, city, e));
        let avgMorale = employees.map((e) => e.mor).reduce((sum, mor) => sum + mor, 0) / employees.length;
        let avgEnergy = employees.map((e) => e.ene).reduce((sum, ene) => sum + ene, 0) / employees.length;
        let avgHappiness = employees.map((e) => e.hap).reduce((sum, hap) => sum + hap, 0) / employees.length;
        if (avgEnergy < office.maxEne * lowerLimit || avgHappiness < office.maxHap * lowerLimit || avgMorale < office.maxMor * lowerLimit) {
            allSatisfied = false;
            break;
        }
    }
    return allSatisfied;
}

async function waitForHappy(division) {
    // TODO: Detect happiness decreasing and bail out.
    while (!allEmployeesSatisfied(division)) {
        log(ns_, `Waiting for employees to be happy.`);
        await ns_.sleep(5000);
    }
    log(ns_, "Employees are happy, continuing with setup.");
}

async function secondGrowthRound() {
    // === Second Growth Round ===
    // (UPSIZE OFFICES)
    await tryUpsizeHireAssignAllOfficesToSize(kAgricultureDivision, 9);
    log(ns_, `Upsized all Agriculture offices to 9 employees`);

    // (MONEY CHECK): Expect around $160b
    // (UPGRADES) PURCHASE:
    // - Smart Factories -> 10
    // - Smart Storage -> 10
    for (const upgrade of [`Smart Factories`, `Smart Storage`]) {
        await upgradeToLevel(upgrade, 10);
    }

    // (MONEY CHECK): Expect around $110b
    // (UPSIZE WAREHOUSES) Upgrade 7 times to 2k
    for (const city of kCities)
        await tryUpgradeWarehouseToSize(kAgricultureDivision, city, 2000);

    // (MONEY CHECK): Expect around $45b
    // (SUPPORT ITEMS) Purchase via one-tick:
    const secondRoundSupportItems = [
        // - Hardware 267.5/s -> 2800
        {
            name: `Hardware`,
            targetQuantity: 2800
        },
        // - Robots 9.6/s -> 96
        {
            name: `Robots`,
            targetQuantity: 96
        },
        // - AI Cores 244.5/s -> 2520
        {
            name: `AI Cores`,
            targetQuantity: 2520
        },
        // - Real Estate 11,940/s -> 146,400
        {
            name: `Real Estate`,
            targetQuantity: 146400
        }
    ];
    await purchaseInOneTick(secondRoundSupportItems);
}

async function thirdGrowthRound() {
    // === Third Growth Round ===
    // (UPSIZE WAREHOUSE): 9 upgrades to 3,800
    for (const city of kCities)
        await tryUpgradeWarehouseToSize(kAgricultureDivision, city, 3800);

    // (SUPPORT MATERIALS) Purchase via one-tick:
    const thirdRoundSupportItems = [
        // - Hardware 650/s -> 9300
        {
            name: `Hardware`,
            targetQuantity: 9300
        },
        // - Robots 63/s -> 726
        {
            name: `Robots`,
            targetQuantity: 726
        },
        // - AI Cores 375/s -> 6270
        {
            name: `AI Cores`,
            targetQuantity: 6270
        },
        // - Real Estate 8,400/s -> 230,400
        {
            name: `Real Estate`,
            targetQuantity: 230400
        }
    ];
    await purchaseInOneTick(thirdRoundSupportItems);
}

async function performTobaccoExpansion() {
    // ===========================
    // === Product Development ===
    // ===========================

    // === Initial Setup ===
    // Expand into `Tobacco` ($20b)

    // TODO search by name and type.
    if (!corp().divisions.find(division => division.type === `Tobacco`)) {
        await waitForFunds(() => corp_.getExpandIndustryCost(`Tobacco`), `expand into the Tobacco industry`);
        corp_.expandIndustry(`Tobacco`, kTobaccoDivision);
    }

    // Expand to `Aevum` then all other cities
    // Upgrade `Aevum` to office size 30
    await tryUpsizeHireAssignOffice(kTobaccoDivision, kProductDevCity, 30);

    // Upgrade all other cities to 9.
    for (const city of kCities) {
        await tryUpsizeHireAssignOffice(kTobaccoDivision, city, 9);
        // Just make sure this is a warehouse at all.
        await tryUpgradeWarehouseToSize(kTobaccoDivision, city, 1);
    }

    // === Develop Product ===
    // Create Product in `Aevum`
    // - Name: Tobacco v1
    // - Design Investment: 1b (1,000,000,000)
    // - Marketing Investment: 1b (1,000,000,000)
    if (getDivision(kTobaccoDivision).products.length === 0) {    
        await waitForFunds(() => 2e9, `create initial Tobacco product`);
        corp_.makeProduct(kTobaccoDivision, kProductDevCity, `Tobacco v1`, 1e9, 1e9);
    }

    // === First-time Loop ===
    // While funds > $3t, purchase `Wilson Analytics`
    while (funds() > 3e12 && funds() > corp_.getUpgradeLevelCost(`Wilson Analytics`)) {
        corp_.levelUpgrade(`Wilson Analytics`);
    }

    // Level the following to 20:
    // - FocusWires
    // - Neural Accelerators
    // - Speech Processor Implants
    // - Nuoptimal Nootropic Injector Implants
    // We already have 2 of each, so 18 more.
    for (const upgrade of [
        `FocusWires`,
        `Neural Accelerators`,
        `Speech Processor Implants`,
        `Nuoptimal Nootropic Injector Implants`,
    ]) {
        await upgradeToLevel(upgrade, 20);
    }

    // Dump money into Advert.Inc for `Tobacco`
    while (funds() > corp_.getHireAdVertCost(kTobaccoDivision)) {
        corp_.hireAdVert(kTobaccoDivision);
    }
}

function maybeDiscontinueProduct() {
    const products = getProducts(kTobaccoDivision);
    if (products.length < 3 || products.some(product => product.developmentProgress < 100))
        return;

    const discontinuedItem = products
        // Don't discontinue products in development (they have 0 rating)
        .filter(product => product.developmentProgress >= 100)
        .reduce((currentMin, product) => product.rat < currentMin.rat ? product : currentMin);
    log(ns_, `Discontinuing product: ${discontinuedItem.name}`, false, `info`);
    corp_.discontinueProduct(kTobaccoDivision, discontinuedItem.name);
}

function maybeDevelopNewProduct() {
    const tobaccoProducts = 
        getProducts(kTobaccoDivision).filter(product => product.name.startsWith(`Tobacco v`));

    // If not developing product, begin development
    const currentlyDevelopingProduct = tobaccoProducts.some((product) => {
        if (verbose && product.developmentProgress < 100)
            log(ns_, `Currently developing product: ${product.name} at %${formatNumberShort(product.developmentProgress)}`);
        return product.developmentProgress < 100;
    });

    if (currentlyDevelopingProduct)
        return;

    let maxVersion = tobaccoProducts
        .map(product => product.name.replaceAll(/[^0-9]+/g, ``)) // Grab version numbers
        .map(Number) // Formally convert for intellisense
        .reduce((max, version) => Math.max(max, version), 0); // Get the max
    const name = `Tobacco v${maxVersion + 1}`;
    log(ns_, `Creating product ${name}.`, false, `info`);
    // TODO: Wait for money, if we don't have enough.
    corp_.makeProduct(kTobaccoDivision, kProductDevCity, name, 1e9, 1e9);
}

const kLabResearchThreshold = 10e3; // 10,000 (2x 5,000)
const kMarketTaResearchThreshold = 140e3; // 140,000 (2x 70,000)
function maybePurchaseResearch() {
    const division = getDivision(kTobaccoDivision);
    const hasLab = corp_.hasResearched(kTobaccoDivision, `Hi-Tech R&D Laboratory`);
    // If >10k, purchase `Hi-Tech R&D Laboratory`
    if (!hasLab && division.research > kLabResearchThreshold) {
        log(ns_, `Purchased R&D Lab.`, false, `success`);
        corp_.research(kTobaccoDivision, `Hi-Tech R&D Laboratory`);
    }
    // If > 140k, purchase `Market-TA.I` and `Market-TA.II`
    const hasMarketTa = corp_.hasResearched(kTobaccoDivision, `Market-TA.II`);
    if (!hasMarketTa && division.research > kMarketTaResearchThreshold) {
        log(ns_, `Purchased Market-TA.II.`, false, `success`);
        corp_.research(kTobaccoDivision, `Market-TA.I`);
        corp_.research(kTobaccoDivision, `Market-TA.II`);
    }
    if (verbose)
        log(ns_, `Researched Lab: ${hasLab}. Researched Market-TA.II: ${hasMarketTa}.`);
}

async function mainTobaccoLoop() {
    // TODO: Maybe kill spending for corp money if it's running.
    if (!disableHashes && 9 in activeSourceFiles_) {
        const fPath = getFilePath('spend-hacknet-hashes.js');
        const args = ['--spend-on', 'Exchange_for_Corporation_Research', '--liquidate'];
        if (ns_.run(fPath, 1, ...args))
            log(ns_, `INFO: Launched '${fPath}' to gain Corp Research more quickly (Can be disabled with --disable-spending-hashes)`);
        else
            log(ns_, `WARNING: Failed to launch '${fPath}' (already running?)`);
    }

    while (true) {
        await sleepWhileNotInStartState(true);
        await writeStats();
        await doPriceDiscovery();
        if (verbose) {
            log(ns_, `Loop start funds ${formatMoney(corp().funds)}. Net: ${formatMoney(corp().revenue - corp().expenses)}/s Revenue: ${formatMoney(corp().revenue)}/s Expenses: ${formatMoney(corp().expenses)}/s`);
        }

        // <Product Development>
        // Discontinue first or we'll get an error (max 3 products).
        if (verbose) {
            log(ns_, `Current division research: ${formatNumberShort(getDivision(kTobaccoDivision).research)}.`);
        }

        // If necessary to make room for new development, discontinue a product.
        // TODO: Consider trick investing one last time when we have 3 products, before discontinuing one.
        maybeDiscontinueProduct();
        maybeDevelopNewProduct();

        // <Research Checks>
        // Only apply if Aevum>60 && 3 products. <-- not anymore
        maybePurchaseResearch();

        // <Spend Funds>
        // 1. Purchase `Wilson Analytics`
        while (await tryUpgradeLevel(`Wilson Analytics`, false))            
            log(ns_, `Upgraded Wilson Analytics to ${corp_.getUpgradeLevel(`Wilson Analytics`)}.`);
        // 2. Upgrade Aevum by 15 or buy Advert, whichever is cheaper
        const kDevOfficeUpgradeIncrement = 15;
        for (let i = 0; i < 1000; ++i) {
            const adVertCost = corp_.getHireAdVertCost(kTobaccoDivision);
            const devOfficeUpgradeCost = corp_.getOfficeSizeUpgradeCost(kTobaccoDivision, kProductDevCity, kDevOfficeUpgradeIncrement);
            const devOfficeSize = getOffice(kTobaccoDivision, kProductDevCity).size;
            const devOfficeAtCapacity = devOfficeSize >= maxOfficeSize + 60;
            const devOfficeAtMinCapacity = devOfficeSize >= 60;

            if (devOfficeAtMinCapacity && funds() > adVertCost && (adVertCost < devOfficeUpgradeCost || devOfficeAtCapacity)) {
                log(ns_, `Hiring AdVert for ${formatMoney(adVertCost)}.`);
                corp_.hireAdVert(kTobaccoDivision);
            } else if (funds() > devOfficeUpgradeCost && !devOfficeAtCapacity) {
                // Upgrade office and hire employees, but we'll wait until after this loop to assign.
                await tryUpsizeHireAssignOffice(kTobaccoDivision, kProductDevCity, devOfficeSize + kDevOfficeUpgradeIncrement,
                    {assignEmployees: false, waitForFunds: false, returnIfNoOfficeUpgrade: false});
            } else {
                // If we didn't do either, end the loop.
                break;
            }
        }
        // Assign new employees if necessary.
        await maybeAutoAssignEmployees(kTobaccoDivision, kProductDevCity);

        // Refresh devOffice in case we changed its size.
        const maxAlternateOfficeSize = Math.min(maxOfficeSize, getOffice(kTobaccoDivision, kProductDevCity).size - 60);
        for (const city of kCities.filter((city) => city != kProductDevCity)) {
            await tryUpsizeHireAssignOffice(kTobaccoDivision, city, maxAlternateOfficeSize,
                { assignEmployees: true, waitForFunds: false, returnIfNoOfficeUpgrade: true });
        }

        // 
        // <Investment>
        // Check Invstors. One more investment at >$800t
        // Potentially one more, but clear
        // Go public at some point. (maybe manual for now)
        // Declare dividends.

        // TODO: Bribe Factions
        // TODO: Maybe wait until dividends are enabled before getting these unlockables.
        for (const unlockable of [`Government Partnership`, "Shady Accounting"]) {
            if (!corp_.hasUnlockUpgrade(unlockable) &&
                corp_.getUnlockUpgradeCost(unlockable) * 2 < funds()) {
                corp_.unlockUpgrade(unlockable);
                log(ns_, `Unlocking one-time upgrade ${unlockable}.`, false, `success`);
            }
        }
        // Upgrades by the fraction we're willing to spend on them.
        const upgrades = [
            [`Wilson Analytics`, 1],
            [`Project Insight`, 0.05],
            [`DreamSense`, 0.05],
            [`ABC SalesBots`, 0.05],
            [`FocusWires`, 0.025],
            [`Speech Processor Implants`, 0.025],
            [`Nuoptimal Nootropic Injector Implants`, 0.025],
            [`Neural Accelerators`, 0.025],
            [`Smart Factories`, 0.02],
            [`Smart Storage`, 0.005],
        ];
        for (const upgradePair of upgrades) {
            const upgrade = String(upgradePair[0]);
            const fraction = Number(upgradePair[1]);
            while (await tryUpgradeLevel(upgrade, false, fraction))
                log(ns_, `Upgraded ${upgrade} to ${corp_.getUpgradeLevel(upgrade)}.`);
        }
    }
}

async function writeStats() {
    let stats = {};
    stats.timestamp = Date.now();
    stats.corp = corp();
    stats.currentOffer = corp_.getInvestmentOffer();
    stats.devProgress = Math.min(...getProducts(kTobaccoDivision).map(product => product.developmentProgress));
    stats.division = getDivision(kTobaccoDivision);
    stats.hasLab = corp_.hasResearched(kTobaccoDivision, `Hi-Tech R&D Laboratory`);
    stats.hasMarketTa = corp_.hasResearched(kTobaccoDivision, `Market-TA.II`);

    const kCorpStatsFile = `/Temp/corp-stats.txt`;
    await ns_.write(kCorpStatsFile, JSON.stringify(stats), `w`);
}

/** @param {NS} ns **/
export async function main(ns) {
    ns.tail();
    ns_ = ns;
    corp_ = ns.corporation;
    // @ts-ignore
    const runOptions = getConfiguration(ns, argsSchema);
    if (!runOptions || await instanceCount(ns) > 1) return; // Prevent multiple instances of this script from being started, even with different args.
    verbose = runOptions[`verbose`];
    maxOfficeSize = runOptions[`max-office-size`];
    ns.disableLog(`ALL`);

    // Simulate trick investing.
    if (runOptions[`simulate-investor-trick`]) {
        await trickInvest(kAgricultureDivision, false);
        return;
    }

    if (runOptions[`simulate-tobacco-investor-trick`]) {
        // TODO: Run loop until 3rd product, run price discovery for a bit, then trick invest.
        await trickInvest(kTobaccoDivision, false);
        return;
    }

    if (runOptions[`only-force-assign-employees`]) {        
        for(const city of kCities)
            await maybeAutoAssignEmployees(kTobaccoDivision, city, true);
        return;
    }

    if (runOptions[`only-do-price-discovery`]) {
        for(const city of kCities)
            await maybeAutoAssignEmployees(kTobaccoDivision, city, true);
        for (let i = 0; i < 10; ++i) {
            await sleepWhileNotInStartState(true);
            doPriceDiscovery();
        }
        return;
    }

    // === Initial Setup ===
    // Set up Corp
    activeSourceFiles_ = await getActiveSourceFiles(ns);
    if (!(3 in activeSourceFiles_))
        return log(ns, "Corporations not enabled.");
    try {
        if (!corp_.hasUnlockUpgrade(`Office API`) || !corp_.hasUnlockUpgrade(`Warehouse API`))
            return log(ns, `This script requires both Office API and Warehouse API to run (BN 3.3 complete).`);
    } catch {
        // Detected no corp.
    }

    // If skipping all setup, just run the loop.
    if (runOptions[`skip-all-setup`])
        return mainTobaccoLoop();

    // TODO: Consider spending hashes on funds here.
    // Set up agriculture.
    if (!await initialSetup())
        return;

    // Wait for happiness so that we get the best deal.
    await waitForHappy();
    // (TARGET CHECK IN) -> ~1.5m/s Profit
    // (INVESTOR MONEY): Accept investment offer for around $210b
    // TODO: Adjust investments for bitnode multipliers
    if (corp().numShares === 1e9 && funds() < 210e9)
        await trickInvest(kAgricultureDivision, true);
    await secondGrowthRound();
    // (INVESTOR MONEY): Accept investment offer for $5t
    if (corp().numShares === 900e6 && funds() < 5e12)
        await trickInvest(kAgricultureDivision, true);
    await thirdGrowthRound();
    // (MULTIPLIER CHECK): TODO: Expect Production Multiplier over 500
    await performTobaccoExpansion();
    await mainTobaccoLoop();
}