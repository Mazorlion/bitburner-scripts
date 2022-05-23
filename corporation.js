import {
    CorpBribePort, getBribeCost
} from './corp-helpers.js';
import {
    formatMoney, formatNumberShort, getActiveSourceFiles, getConfiguration, getFilePath, instanceCount, log, tryGetBitNodeMultipliers
} from './helpers.js';

let options = null; // The options used at construction time
const argsSchema = [ // The set of all command line arguments
    ['verbose', true], // Should the script print debug logging.
    ['skip-all-setup', false], // Should we just jump straight to the loop?
    [`max-office-size`, 1250], // Cap size of offices for game performance.
    [`disable-spending-hashes`, false], // If true, will not start spend-hashes.
    // The following flags are exclusive. TODO: Enforce that with an error.
    [`simulate-agriculture-investor-trick`, false], // If true will simulate the gains of agriculture tick investing
    [`simulate-tobacco-investor-trick`, false], // If true will simulate the gains of Tobacco trick investing
    [`only-do-price-discovery`, false], // If true will assign tobacco employees then adjust price for 10 ticks.
    [`only-force-assign-employees`, false], // If true will force rebalance Tobacco employees
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
 * Sleeps while waiting for the START state.
 * @param {Boolean} [waitForNext = false] If currently in a START state, will sleep until the next one if true.
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
 * @param {Material} material material to purchase
 * @param {Number} desiredValue desired end value
 * @returns {Number} per-second rate to purchase to achieve `desiredValue`
 */
function calculateOneTickPurchaseRate(material, desiredValue) {
    const currentAmount = material.qty;
    const secondsPerTick = 10;
    return (desiredValue - currentAmount) / 10;
}

/**
 * @typedef {Object} MaterialPurchaseDefinition
 * @property {String} name name of the material to purchase
 * @property {Number} targetQuantity target quantity to have in the warehouse after one tick
 */
/**
 * Purchase the given item quantities in a single tick.
 * @param {MaterialPurchaseDefinition[]} items Items specifications to purchase
 */
async function purchaseInOneTick(items) {
    // TODO: Check for warehouse capacity.
    // Wait for START, but if we're already in one that's fine.
    await sleepWhileNotInStartState(false);
    // Pairs of city x item.
    const cityItemPairs = kCities.reduce(
        (res, city) => res.concat(
            items.map((item) => ({ city: city, item: item }))), []);
    let needPurchase = false;
    // For each pair caluclate the rate needed.
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
    // Clean up our purchase orders.
    cityItemPairs.forEach(pair => {
        const city = pair.city;
        const item = pair.item;
        corp_.buyMaterial(kAgricultureDivision, city, item.name, 0);
        const endingQuantity = corp_.getMaterial(kAgricultureDivision, city, item.name).qty;
        if (endingQuantity !== item.targetQuantity) {
            log(ns_, `Expected ${item.name} to finish with ${formatNumberShort(item.targetQuantity)} but ended with ${formatNumberShort(endingQuantity)} in ${city}.`);
        }
    });
}

/**
 * Performs price discovery for all products in kTobaccoDivision.
 * 
 * Before Market-TA.II, uses the production overflow into the warehouse to calculate a good price.
 * Ideally selects a price where produced == sold, in the steady state.
 * 
 * With Market-TA.II, just enables that and returns.
 */
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

/**
 * @callback targetFunction
 * @return {Number} Returns the threshold of funds at which to unblock.
 */
/**
 * Waits for a threshold of corp funds before unblocking.
 * @param {targetFunction} targetFunction Invoked each cycle to see if we're at the correct threshold.
 * @param {String} reason Reason we're waiting for funds. No capitalization, no period at the end.
 * @param {Number} [sleepDuration=15000] Duration to sleep for between checks.
 */
async function waitForFunds(targetFunction, reason, sleepDuration = 15000) {
    while (targetFunction() > funds()) {
        log(ns_, `Waiting for money to ${reason}. Have: ${formatMoney(funds())}, Need: ${formatMoney(targetFunction())}`);
        await ns_.sleep(sleepDuration);
    }
}

/**
 * Set the amount to sell for all goods for a given division.
 * @param {String} division Division to set for
 * @param {String} amount Amount of all products/materials to sell
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
 * Perform trick investing by stocking up on material/product then selling a lot in a single tick.
 * @param {String} division Name of a division
 * @param {boolean} [acceptInvestment=true] If true, will actually accept a large enough investment.
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
        // TODO: Maybe just sleepWhileNotInStartState(true) here.
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
    // TODO: Consider doing it with shares just on the later rounds?
	// corp_.goPublic(800e6);

	for (const city of kCities) {
        // Force rebalance employees.
        await maybeAutoAssignEmployees(division, city, true);
	}
}

/**
 * Conditionally expand a division to a new city.
 * @param {String} division Division to expand
 * @param {String} city City to expand to
 * @param {Boolean} [wait=true] If true, will block until sufficient funds for expansion
 * @returns True if expanded, false otherwise.
 */
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
/**
 * Enables smart supply on `division`, if it has a warehouse.
 * @param {String} division Name of a division
 */
function setSmartSupply(division) {
    for (const city of kCities) {
        if (corp_.hasWarehouse(division, city))
            corp_.setSmartSupply(division, city, true);
    }
}

/**
 * Fills a given office's size with employees. Does not assign them.
 * @param {String} division division to fill
 * @param {String} city office to fill
 */
function fillEmployees(division, city) {
    while (numEmployees(division, city) < getOffice(division, city).size) {
        corp_.hireEmployee(division, city);
    }
}

/**
 * Auto assigns employees in the given {division, city} pair.
 * @param {String} division 
 * @param {String} city 
 * @param {Boolean} [forceAssign=false] Should we force-reassign even if all employees have jobs
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

// 
/**
 * Conditionally upgrade a city's office.
 * @param {String} division Division to upgrade
 * @param {String} city City to upgrade
 * @param {Number} targetSize Desired end size of the office in city
 * @param {Boolean} [wait=true] If true, will wait for funds. If false, will either purchase or return false.
 * @returns {Promise<Boolean>} Returns true if an upgrade happened, false otherwise.
 */
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
 * @typedef {Object} OfficeUpgradeSettings
 * @property {Boolean} assignEmployees If true, will attempt to assign employees after hiring.
 * @property {Boolean} waitForFunds If true, will block until funds are available. If false will either purchase or return false.
 * @property {Boolean} returnIfNoOfficeUpgrade If true, will return false if no upgrade happened. If false, will continue if no upgrade happened.
 */
/**
 * Conditionally expand, upgrade size, hire, assign employees in a given office.
 * @param {String} division Name of the division to upgrade
 * @param {String} city Name of the city to upgrade
 * @param {Number} targetSize Desired number of employees
 * @param {OfficeUpgradeSettings} [upgradeSettings=defaultUpgradeOfficeSettings] Additional function settings.
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

/**
 * Attempts to upgrade all offices for a given division to targetSize.
 * Will block until funds are available for each office.
 * @param {String} division Division Name
 * @param {Number} targetSize Desired Office Size
 */
async function tryUpsizeHireAssignAllOfficesToSize(division, targetSize) {
    for (const city of kCities) {
        await tryUpsizeHireAssignOffice(division, city, targetSize);
    }
}

/**
 * Purchases a warehouse if necessary, then upgrades it to targetSize.
 * @param {String} division Name of division to purchase for
 * @param {String} city City of the warehouse to purchase for
 * @param {Number} targetSize Desired target size of the warehouse (includes upgrades)
 */
async function upgradeWarehouseToSize(division, city, targetSize) {
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

/**
 * Conditionally level up `upgrade`.
 * @param {String} upgrade Name of the upgrade to level
 * @param {Boolean} [wait=true] If true, will wait for funds. If false, will return false if insufficient funds.
 * @param {Number} [fundsFraction=1] [0,1] fraction of total corp funds we can spend on this upgrade. Wait is ignored if <1.
 * @returns 
 */
async function tryUpgradeLevel(upgrade, wait = true, fundsFraction = 1) {
    if (fundsFraction == 1 && wait)
        await waitForFunds(() => corp_.getUpgradeLevelCost(upgrade), `upgrade ${upgrade} to ${corp_.getUpgradeLevel(upgrade) + 1}`);
    else if (funds() * fundsFraction < corp_.getUpgradeLevelCost(upgrade))
        return false;
    corp_.levelUpgrade(upgrade);
    return true;
}

/**
 * Level `upgrade` to `targetLevel`. Will block until funds are available.
 * @param {String} upgrade Name of the upgrade whose level to increase.
 * @param {Number} targetLevel Level to which `upgrade` should be upgraded.
 */
async function upgradeToLevel(upgrade, targetLevel) {
    while (corp_.getUpgradeLevel(upgrade) < targetLevel)
        await tryUpgradeLevel(upgrade);
}

/**
 * Perform initial setup of the corp and the Agriculture division.
 */
async function initialSetup() {
    // Log these functions for ease of information.
    ns_.enableLog(`ALL`);
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
        await upgradeWarehouseToSize(kAgricultureDivision, city, 300);
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
 * Checks if all employees in a division have sufficients happiness stats.
 * @param {String} [division=kAgricultureDivision] Division to check for
 * @param {Number} [lowerLimit=0.99998] - minimum for all stats, default 99.998%. [0,1]
 * @returns {Boolean} True if all employees are happy, false otherwise.
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

/**
 * Waits until all employees of `division` are sufficiently happy.
 * @param {String} division name of the division to wait for
 */
async function waitForHappy(division) {
    // TODO: Detect happiness decreasing and bail out.
    while (!allEmployeesSatisfied(division)) {
        log(ns_, `Waiting for employees to be happy.`);
        await ns_.sleep(5000);
    }
    log(ns_, "Employees are happy, continuing with setup.");
}

/**
 * Performs the second round of upgrades to Agriculture.
 */
async function secondGrowthRound() {
    // === Second Growth Round ===
    // (UPSIZE OFFICES)
    await tryUpsizeHireAssignAllOfficesToSize(kAgricultureDivision, 9);

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
        await upgradeWarehouseToSize(kAgricultureDivision, city, 2000);

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

/**
 * Performs the final round of upgrades to Agriculture.
 */
async function thirdGrowthRound() {
    // === Third Growth Round ===
    // (UPSIZE WAREHOUSE): 9 upgrades to 3,800
    for (const city of kCities)
        await upgradeWarehouseToSize(kAgricultureDivision, city, 3800);

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

/**
 * Expands to the Tobacco industry, does initial office setup, then starts product development.
 */
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
        await upgradeWarehouseToSize(kTobaccoDivision, city, 1);
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

/**
 * Conditionally discontinues the lowest-rated product if we're at 3 products and none are being developed.
 */
function maybeDiscontinueProduct() {
    const products = getProducts(kTobaccoDivision);
    // TODO: Max can be increase with upgrades, don't hardcode 3.
    if (products.length < 3 || products.some(product => product.developmentProgress < 100))
        return;

    const discontinuedItem = products
        // Don't discontinue products in development (they have 0 rating)
        .filter(product => product.developmentProgress >= 100)
        .reduce((currentMin, product) => product.rat < currentMin.rat ? product : currentMin);
    log(ns_, `Discontinuing product: ${discontinuedItem.name}`, false, `info`);
    corp_.discontinueProduct(kTobaccoDivision, discontinuedItem.name);
}

/**
 * Begins product development if non are currently being developed.
 */
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
/**
 * Conditionally purchases the Lab and Market.TA-II researches if we have double their cost.
 */
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

/**
 * Attempts to fulfill requests for bribing factions.
 * @param {CorpBribePort} bribePort port to read from
 */
function maybeBribeFactions(bribePort) {
    if (!bribePort)
        return;

    const kBribeSpendingFraction = 0.05; // 5%
    let infiniteLoopDefense = 100;
    while (!bribePort.isEmpty() && --infiniteLoopDefense) {
        let bribe = bribePort.readBribe();
        if (!bribe)
            continue;

        // We don't care about the RAM cost here because the relative cost (1 TiB vs 16 GiB at worst) is small.
        const currentRep = ns_.singularity.getFactionRep(bribe.faction);
        const cost = getBribeCost(currentRep, bribe.targetReputation);
        if (cost > 0 && funds() * kBribeSpendingFraction > cost) {
            try {
                const result = corp_.bribe(bribe.faction, cost, 0);
                log(ns_, `Attempted Bribe ${bribe.faction} to ${formatNumberShort(bribe.targetReputation)} rep costing ${formatMoney(cost)}: ${result}`);
            } catch (error) {
                log(ns_, `Failed to bribe ${bribe.faction}: ${error}`);
            }
        }
    }
}

/**
 * If we have enough money do the cheapest of:
 *   - Hire AdVert for Tobacco
 *   - Upgrade product dev office by 15
 * Loop stops at 1,000 times for infinite loop protection.
 */
async function growDevOfficeOrHireAdVert() {
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
                { assignEmployees: false, waitForFunds: false, returnIfNoOfficeUpgrade: false });
        } else {
            // If we didn't do either, end the loop.
            break;
        }
    }
    // Assign new employees if necessary.
    await maybeAutoAssignEmployees(kTobaccoDivision, kProductDevCity);
}

/**
 * If we have the funds, upgrade non-product-dev offices to within kNonDevOfficeOffset.
 */
async function maybeGrowNonDevOffices() {
    const kNonDevOfficeOffset = 60; // Min difference between development office and others.
    const maxAlternateOfficeSize = Math.min(maxOfficeSize, getOffice(kTobaccoDivision, kProductDevCity).size - kNonDevOfficeOffset);
    for (const city of kCities.filter((city) => city != kProductDevCity)) {
        await tryUpsizeHireAssignOffice(kTobaccoDivision, city, maxAlternateOfficeSize,
            // Don't wait for funds and bail early if no upgrade happened.
            { assignEmployees: true, waitForFunds: false, returnIfNoOfficeUpgrade: true });
    }
}

/**
 * Conditionally make the corp public and start dividends.
 */
function maybeGoPublic() {
    if (corp().public)
        return;
    // TODO: Pick a better value, this is just to remove all thought for now.
    if (funds() > 1e30) {
        corp_.goPublic(1); // Just one share to enable dividends, we don't need the money.
        corp_.issueDividends(0.1); // 10%
    }
}

/**
 * Purchase the dividend unlockables if we need them.
 */
function tryPurchaseDividendUnlockables() {
    if (!corp().public)
        return;

    [`Government Partnership`, "Shady Accounting"]
        // Exclude it if we have it.
        .filter(upgrade => !corp_.hasUnlockUpgrade(upgrade))
        // Require 2x cost to purchase.
        .filter(upgrade => funds() > 2 * corp_.getUnlockUpgradeCost(upgrade))
        .forEach(upgrade => {
            corp_.unlockUpgrade(upgrade);
            log(ns_, `Unlocking one-time upgrade ${upgrade}.`, false, `success`);
        });
}

/**
 * Attempt to level corp upgrades if we have enough money.
 * TODO: Maybe lower multipliers before Aevum is at some critical mass.
 */
async function tryLevelUpgrades() {
    // Upgrades by the fraction we're willing to spend on them.
    const upgrades = [
        [`Wilson Analytics`, 1], // 100%
        [`Project Insight`, 0.05], // 5%
        [`DreamSense`, 0.05],  // 5%
        [`ABC SalesBots`, 0.05], // 5%
        [`FocusWires`, 0.025], // 2.5%
        [`Speech Processor Implants`, 0.025], // 2.5%
        [`Nuoptimal Nootropic Injector Implants`, 0.025], //2.5%
        [`Neural Accelerators`, 0.025], // 2.5%
        [`Smart Factories`, 0.02], // 2%
        [`Smart Storage`, 0.001], //0.01%
    ];
    for (const upgradePair of upgrades) {
        const upgrade = String(upgradePair[0]);
        const fraction = Number(upgradePair[1]);
        while (await tryUpgradeLevel(upgrade, false, fraction))
            log(ns_, `Upgraded ${upgrade} to ${corp_.getUpgradeLevel(upgrade)}.`);
    }
}

/**
 * The core of the corporation once everything is set up. Does the following:
 *   - Starts spending hashes on corp research
 *   - Writes stats out for stats.js
 *   - Updates the prices of tobacco products
 *   - Discontinues a product when at maximum
 *   - Develops new products continuously
 *   - Purchases tobacco division research
 *   - Purchases Corp upgrades (Wilson)
 *   - Upgrades tobacco product dev office or purchases AdVert
 *   - Upgrades non-dev offices to a fixed threshold below the dev office
 *   - Purchases one-time dividend boosting upgrades if public
 *   - Purchases other corp upgrades with fractional corp funds
 */
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
    let bribePort = new CorpBribePort(ns_);
    // TODO: Consider hard-reassign every N loops to cover bugs.
    while (true) {
        await sleepWhileNotInStartState(true); // Wait for a corp tick.
        await writeStats(); // Write out stats for stats.js.
        await doPriceDiscovery(); // Update product prices based on sales from last tick.
        if (verbose) {
            log(ns_, `Loop start funds ${formatMoney(corp().funds)}. Net: ${formatMoney(corp().revenue - corp().expenses)}/s Revenue: ${formatMoney(corp().revenue)}/s Expenses: ${formatMoney(corp().expenses)}/s`);            
            log(ns_, `Current division research: ${formatNumberShort(getDivision(kTobaccoDivision).research)}.`);
        }
        // <Product Development>
        // TODO: Consider trick investing one last time when we have 3 products, before discontinuing one.
        // Discontinue first or we'll get an error (max 3 products).
        maybeDiscontinueProduct(); // Discontinue a product to make room for a new one.
        maybeDevelopNewProduct(); // Develop a new product if we are not currently.
        // <Research Checks>
        // TODO: Only apply if Aevum>60 && 3 products?
        maybePurchaseResearch(); // Purchase research if we can.
        // <Spend Funds>
        while (await tryUpgradeLevel(`Wilson Analytics`, false)) // 1. Purchase `Wilson Analytics`             
            log(ns_, `Upgraded Wilson Analytics to ${corp_.getUpgradeLevel(`Wilson Analytics`)}.`);        
        await growDevOfficeOrHireAdVert(); // 2. Upgrade Aevum by 15 or buy Advert, whichever is cheaper
        await maybeGrowNonDevOffices(); // 3. Grow other offices to match dev office

        // <Investment>
        // TODO: Check Invstors. One more investment at >$800t
        maybeGoPublic(); // Go public and issue dividends
        maybeBribeFactions(bribePort); // Attempt service bribe requests.
        tryPurchaseDividendUnlockables(); // Attempt to purchase reduced-tax dividend upgrades.
        await tryLevelUpgrades(); // Level up corp upgrades
    }
}

/**
 * Writes out stats to /Temp/corp-stats.txt for consumption by stats.js.
 */
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

    activeSourceFiles_ = await getActiveSourceFiles(ns);
    if (!(3 in activeSourceFiles_))
        return log(ns, "Corporations not enabled.");

    /**
     * @type {BitNodeMultipliers}
     */
    const bitnodeMults = await tryGetBitNodeMultipliers(ns);
    // TODO: Handle BN5 not complete. (Multipliers unavailable)
    if (bitnodeMults.CorporationValuation <= 0.1 || bitnodeMults.CorporationSoftcap < 0.1)
        return log(ns_, `Bitnode multipliers too low. Limit 10%` +
            `CorpValuation: ${bitnodeMults.CorporationValuation * 100}%, ` + 
            `CorpSoftCap: ${bitnodeMults.CorporationSoftcap*100}%`);

    if (runOptions[`simulate-agriculture-investor-trick`])
        return await trickInvest(kAgricultureDivision, false);


    if (runOptions[`simulate-tobacco-investor-trick`])
        // TODO: Run loop until 3rd product, run price discovery for a bit, then trick invest.
        return await trickInvest(kTobaccoDivision, false);

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
    await waitForHappy(kAgricultureDivision);
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