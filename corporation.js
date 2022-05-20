import {
    formatMoney, formatNumberShort, getActiveSourceFiles, getConfiguration, log
} from './helpers.js';

let options = null; // The options used at construction time
const argsSchema = [ // The set of all command line arguments
    ['verbose', false], // Should the script print debug logging.
];
export function autocomplete(data, args) {
    data.flags(argsSchema);
    return [];
}

const kCorpName = `Hemmy`;
const kAgricultureDivision = `Ag`;
const kTobaccoDivision = `Tobacco`;
const kCities = [`Aevum`, `Sector-12`, `Chongqing`, `Ishima`, `Volhaven`, `New Tokyo`];
const kProductDevCity = `Aevum`;
const kMaxOfficeSize = 1000;

const upgrades = [
    `Wilson Analytics`,
    `Project Insight`,
    `ABC SalesBots`,
    `FocusWires`,
    `Speech Processor Implants`,
    `Nuoptimal Nootropic Injector Implants`,
    `Neural Accelerators`,
    `DreamSense`,
    `Smart Factories`,
    `Smart Storage`,
];

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
 * @param {String} city 
 * @returns {Office}
 */
let office = (division, city) => corp_.getOffice(division, city);
let numEmployees = (division, city) => office(division, city).employees.length;

// args
let verbose;

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
async function calculateOneTickPurchaseRate(material, desiredValue) {
    const currentAmount = material.qty;
    const secondsPerTick = 10;
    return (desiredValue - currentAmount) / 10;
}

async function purchaseInOneTick(items) {
    // Wait for START, but if we're already in one that's fine.
    await sleepWhileNotInStartState(ns_, false);
    const cityItemPairs = kCities.reduce(
        (res, city) => res.concat(
            items.map((item) => ({ city: city, item: item }))), []);
    cityItemPairs.forEach(pair => {
        const city = pair.city;
        const item = pair.item;
        const targetRate = calculateOneTickPurchaseRate(corp_.getMaterial(kAgricultureDivision, city, item.name), item.targetQuantity);
        if (targetRate <= 0) {
            log(ns_, `Not purchasing ${item.name} because we already have sufficient in the warehouse.`);
            return;
        }
        log(ns_, `Purchasing ${item.name} in ${city} at ${targetRate}.`)
        corp_.buyMaterial(kAgricultureDivision, city, item.name, targetRate);
    });
    // Wait for purchases to be made by waiting for the next START.
    await sleepWhileNotInStartState(ns_, true);
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
            division.products.forEach((product) => corp_.sellProduct(division.name, city, product, 'MAX', 'MP'));
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

async function waitForFunds(targetFunction, reason, sleepDuration = 3000) {
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

async function maybeExpandCity(division, city, waitForFunds = true) {
    if (getDivision(division).cities.includes(city))
        return;
    if (waitForFunds)
        await waitForFunds(() => corp_.getExpandCityCost(), `expand to ${city}`);
    else if (funds() < corp_.getExpandCityCost()) 
        return false;
    corp_.expandCity(city);
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
    while (numEmployees(division, city) < office(division, city).size) {
        corp_.hireEmployee(division, city);
    }
}

async function maybeAutoAssignEmployees(division, city) {
    // All employees working, nothing to do.
    if (office(division, city).employeeJobs[`Unassigned`] === 0)
        return;

    const numEmployees = numEmployees(division, city);
    // Special case 9
    if (numEmployees === 9) {
        for (const job of [`Operations`, `Engineer`, `Management`, `Research & Development`]) {
            await corp_.setAutoJobAssignment(division, city, job, 2);
        }
        await corp_.setAutoJobAssignment(division, city, `Business`, 1);
        return;
    }

    // Evenly balance employees otherwise, preferring ones earlier in this list.
    const jobs = [`Operations`, `Engineer`, `Business`, `Management`, `Research & Development`];
    const baseEmployees = Math.floor(numEmployees / jobs.length);
    for (let i = 0; i < jobs.length; ++i) {
        const adjustment = i < numEmployees % jobs.length ? 1 : 0;
        await corp_.setAutoJobAssignment(division, city, jobs[i], baseEmployees + adjustment);
    }
}

// Returns true if an upgrade happened, false otherwise.
async function tryUpgradeOfficeSize(division, city, targetSize, waitForFunds = true) {
    const startingSize = office(division, city).size;
    if (startingSize >= targetSize)
        return false;

    const increment = targetSize - startingSize;
    log(ns_, `Upgrading ${city} by ${increment} to ${targetSize}.`);

    const costFunction = () => corp_.getOfficeSizeUpgradeCost(divion, city, increment);
    const reason = `upgrade ${city} by ${increment} to ${targetSize}`
    if (waitForFunds)
        await waitForFunds(costFunction, reason);
    else if (funds() < costFunction())
        return false;

    corp_.upgradeOfficeSize(division, city, increment);
    return true;
}

const defaultUpgradeOfficeSettings = { assignEmployees: true, waitForFunds: true, returnIfNoOfficeUpgrade: false };
async function tryUpsizeHireAssignOffice(division, city, targetSize, upgradeSettings = defaultUpgradeOfficeSettings) {
    maybeExpandCity(division, city, upgradeSettings.waitForFunds);
    if (numEmployees(division, city) >= targetSize)
        return false;
    let sizeChangeHappened = await tryUpgradeOfficeSize(division, city, targetSize, upgradeSettings.waitForFunds);
    if (!sizeChangeHappened && returnIfNoOfficeUpgrade)
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

async function tryUpgradeWarehouseSize(division, city, targetSize) {
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
async function tryUpgradeLevel(upgrade, waitForFunds = true, fundsFraction = 1) {
    if (fundsFraction == 1 && waitForFunds)
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
    if (corp() === undefined) {
        while (ns_.getPlayer().money < 160e9) {
            log(ns_, `Waiting for corp seed money. Have ${formatMoney(ns.getPlayer().money)}, want ${formatMoney(160e9)}`);
            await ns_.sleep(30000);
        }
        corp_.createCorporation(kCorpName, true);
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

    kCities.forEach((city) => await tryUpgradeWarehouseSize(kAgricultureDivision, city, 300));
    // Start selling `Plants` and `Food` for MAX/MP
    kCities.forEach((city) => {
        corp_.sellMaterial(kAgricultureDivision, city, `Plants`, `MAX`, `MP`, /*allCities=*/true);
        corp_.sellMaterial(kAgricultureDivision, city, `Food`, `MAX`, `MP`, /*allCities=*/true);
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

async function waitForHappy() {
    // (WAIT FOR HAPPINESS): I think this API might be broken, so just expect a specific offer size for now.
    // let happy = false;
    // while (!happy) {
    //     await sleepWhileNotInStartState(ns_, true);
    //     happy = true;
    //     for (const city of cities) {
    //         const office = office(agricultureDivisionName, city);
    //         // - Morale 100.0
    //         const morale = office.maxMor;
    //         if (morale < 100) {
    //             log(ns_, `Waiting for ${city} due to morale. At ${morale}, need 100.`);
    //             happy = false;
    //             break;
    //         }
    //         // - Energy at least 99.998
    //         const energy = office.maxEne;
    //         if (energy < 99.998) {
    //             log(ns_, `Waiting for ${city} due to energy. At ${energy}, need 99.998.`);
    //             happy = false;
    //             break;
    //         }
    //         // - Happiness at least 99.998
    //         const happiness = office.maxHap;
    //         if (happiness < 99.998) {
    //             log(ns_, `Waiting for ${city} due to happiness. At ${happiness}, need 99.998.`);
    //             happy = false;
    //             break;
    //         }
    //     }
    // }
    // log(ns_, "Employees are happy, continuing with setup.");
    return true;
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
    kCities.forEach((city) => await tryUpgradeWarehouseSize(kAgricultureDivision, city, 2000));

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
    kCities.forEach((city) => await tryUpgradeWarehouseSize(kAgricultureDivision, city, 3800));

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
    if (!corp().divisions.find(division => division.type === `Tobacco`))
        corp_.expandIndustry(`Tobacco`, kTobaccoDivision);

    // Expand to `Aevum` then all other cities
    // Upgrade `Aevum` to office size 30
    await tryUpgradeOfficeSize(kTobaccoDivision, kProductDevCity, 30);
    await tryUpgradeWarehouseSize(kTobaccoDivision, kProductDevCity, 300);

    // Upgrade all other cities to 9.
    kCities.filter((city) => city != kProductDevCity)
        .forEach((city) => {
            await tryUpgradeOfficeSize(kTobaccoDivision, city, 9);
            await tryUpgradeWarehouseSize(kTobaccoDivision, city, 300);
        });

    // === Develop Product ===
    // Create Product in `Aevum`
    // - Name: Tobacco v1
    // - Design Investment: 1b (1,000,000,000)
    // - Marketing Investment: 1b (1,000,000,000)
    await waitForFunds(() => 1e9, `create initial Tobacco product`);
    corp_.makeProduct(kTobaccoDivision, kProductDevCity, `Tobacco v1`, 1e9, 1e9);

    // === First-time Loop ===
    // While funds > $3t, purchase `Wilson Analytics`
    while (funds() > 3e12) {
        // TODO check wilson price?
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
 * 
 * @returns {Number} Highest version amongst currently produced products.
 */
function maybeDiscontinueProduct() {
    // TODO: Discontinue based on rating/revenue.
    let tobaccoProducts = getDivision(kTobaccoDivision).products
        .filter(product =>
            product.startsWith(`Tobacco v`) && corp_.getProduct(kTobaccoDivision, product).developmentProgress >= 100
        ).map(
            product => product.replaceAll(/[^0-9]+/g, ``)
        );
    if (tobaccoProducts.length >= 3) {
        let minItem = Math.min(...tobaccoProducts);
        let discontinuedItem = `Tobacco v${minItem}`;
        log(ns_, `Discontinuing product: ${discontinuedItem}`, false, `info`);
        corp_.discontinueProduct(kTobaccoDivision, discontinuedItem);
    }
    return Math.max(...tobaccoProducts) || 0;;
}

/**
 * 
 * @param {Number} latestVersionSuffix The highest currently in-use version suffix.
 */
function maybeDevelopNewProduct(latestVersionSuffix) {
    // If not developing product, begin development
    let isProductInDevelopment = false;
    for (const product of getDivision(kTobaccoDivision).products) {
        if (corp_.getProduct(kTobaccoDivision, product).developmentProgress < 100) {
            isProductInDevelopment = true;
            if (verbose)
                log(ns_, `Currently developing product: ${product} at %${formatNumberShort(corp_.getProduct(kTobaccoDivision, product).developmentProgress)}`);
            break;
        }
    }

    const name = `Tobacco ${latestVersionSuffix + 1}`;
    if (!isProductInDevelopment) {
        log(ns_, `Creating product ${name}.`, false, `info`);
        corp_.makeProduct(kTobaccoDivision, kProductDevCity, name, 1e9, 1e9);
    }
}

const kLabResearchThreshold = 10e3;
const kMarketTaResearchThreshold = 140e3;
function maybePurchaseResearch() {
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
    while (true) {
        await sleepWhileNotInStartState(ns_, true);
        await doPriceDiscovery(ns_);
        if (verbose) {
            const corp = corp();
            log(ns_, `Loop start funds ${formatMoney(corp.funds)}. Net: ${formatMoney(corp.revenue - corp.expenses)}/s Revenue: ${formatMoney(corp.revenue)}/s Expenses: ${formatMoney(corp.expenses)}/s`);
        }

        // <Product Development>
        // Discontinue first or we'll get an error (max 3 products).
        if (verbose) {
            log(ns_, `Current division research: ${formatNumberShort(getDivision(kTobaccoDivision).research)}.`);
        }

        // If necessary to make room for new development, discontinue a product.
        const latestVersionSuffix = maybeDiscontinueProduct();
        maybeDevelopNewProduct(latestVersionSuffix);

        // <Research Checks>
        // Only apply if Aevum>60 && 3 products. <-- not anymore
        maybePurchaseResearch();

        // <Spend Funds>
        // 1. Purchase `Wilson Analytics`
        while (tryUpgradeLevel(`Wilson Analytics`, false))            
            log(ns_, `Upgraded Wilson Analytics for ${formatMoney(corp_.getUpgradeLevelCost(`Wilson Analytics`))}`);
        // 2. Upgrade Aevum by 15 or buy Advert, whichever is cheaper
        const kDevOfficeUpgradeIncrement = 15;
        for (let i = 0; i < 1000; ++i) {
            const adVertCost = corp_.getHireAdVertCost(kTobaccoDivision);
            const devOfficeUpgradeCost = corp_.getOfficeSizeUpgradeCost(kTobaccoDivision, kProductDevCity, kDevOfficeUpgradeIncrement);
            const devOfficeSize = office(kTobaccoDivision, kProductDevCity).size;
            const devOfficeAtCapacity = devOfficeSize >= kMaxOfficeSize + 60;

            if (funds() > adVertCost && (adVertCost < devOfficeUpgradeCost || devOfficeAtCapacity)) {
                log(ns_, `Hiring AdVert for ${formatMoney(adVertCost)}.`);
                corp_.hireAdVert(kTobaccoDivision);
            } else if (funds() > devOfficeUpgradeCost && devOfficeUpgradeCost < adVertCost && !devOfficeAtCapacity) {
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
        const maxAlternateOfficeSize = Math.min(kMaxOfficeSize, office(kTobaccoDivision, kProductDevCity).size - 60);
        kCities.filter((city) => city != kProductDevCity)
            .some((city) => 
                await tryUpsizeHireAssignOffice(kTobaccoDivision, city, maxAlternateOfficeSize, 
                    { assignEmployees: true, waitForFunds: false, returnIfNoOfficeUpgrade: true })
            );

        // 
        // <Investment>
        // Check Invstors. One more investment at >$800t
        // Potentially one more, but clear
        // Go public at some point. (maybe manual for now)
        // Declare dividends.

        // TODO: Bribe Factions
        for (const unlockable of [`Government Partnership`, "Shady Accounting"]) {
            if (!corp_.hasUnlockUpgrade(unlockable) &&
                corp_.getUnlockUpgradeCost(unlockable) < funds()) {
                corp_.unlockUpgrade(unlockable);
                log(ns_, `Unlocking one-time upgrade ${unlockable}.`, false, `success`);
            }
        }
        const kUpgradeFundsFraction = 0.005; // 0.5%
        for (const upgrade of upgrades) {
            while (tryUpgradeLevel(upgrade, false, kUpgradeFundsFraction)) {
                log(ns_, `Upgraded ${upgrade} to ${corp_.getUpgradeLevel(upgrade)} for ${formatMoney(nextUpgradeCost)}.`);
            }
        }
    }
}

/** @param {NS} ns **/
export async function main(ns) {
    ns_ = ns;
    corp_ = ns.corporation;
    const runOptions = getConfiguration(ns, argsSchema);
    verbose = runOptions[`verbose`];
    ns.disableLog(`ALL`);

    // === Initial Setup ===
    // Set up Corp
    const activeSourceFiles = await getActiveSourceFiles(ns);
    if (!(3 in activeSourceFiles))
        return log(ns, "Corporations not enabled.");

    if (!corp_.hasUnlockUpgrade(`Office API`) || !corp_.hasUnlockUpgrade(`Warehouse API`))
        return log(ns, `This script requires both Office API and Warehouse API to run (BN 3.3 complete).`);

    // Set up agriculture.
    if (!await initialSetup())
        return;

    // Wait for happiness so that we get the best deal.
    await waitForHappy();
    // (TARGET CHECK IN) -> ~1.5m/s Profit
    // (INVESTOR MONEY): Accept investment offer for around $210b
    // TODO: Adjust investments for bitnode multipliers
    await waitForInvestmentOffer(2.10e9);
    await secondGrowthRound();
    // (INVESTOR MONEY): Accept investment offer for $5t
    await waitForInvestmentOffer(5e12);
    await thirdGrowthRound();
    // (MULTIPLIER CHECK): TODO: Expect Production Multiplier over 500
    await performTobaccoExpansion();

    //TODO: Write a file once we're set up so we can avoid all the earlier work on startup.
    await mainTobaccoLoop();
}