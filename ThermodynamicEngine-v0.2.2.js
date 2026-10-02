import { ExponentialCost, FirstFreeCost, FreeCost, CustomCost } from "./api/Costs";
import { BigNumber } from "./api/BigNumber";
import { theory } from "./api/Theory";
import { Utils } from "./api/Utils";
import { ui } from "./api/ui/UI";
import { LayoutOptions } from "./api/ui/properties/LayoutOptions";

var id = "thermodynamic_engine";
var name = "Thermodynamic Engine";
var description = "Build a finite-temperature heat engine, balance load against efficiency, and turn irreversibility into statistical opportunity. Prototype v0.2.1: extreme-temperature heat engines with rebalanced entropy progression.";
var authors = "75yoshiishion-ship-it, developed with Codex";
var version = 3;
requiresGameVersion("1.4.38");

// All unbounded arithmetic passes through these SDK operator helpers.
// The headless harness replaces only these helpers, not the model or tick.
var bAdd = (a, b) => a + b;
var bSub = (a, b) => a - b;
var bMul = (a, b) => a * b;
var bDiv = (a, b) => a / b;
var BN = (x) => BigNumber.from(x);
var pow10 = (x) => BigNumber.TEN.pow(x);
const CONFIG = {
    tauPower: 0.25, pubPower: 0.44,
    milestones: [18, 24, 35, 60, 100, 125, 210, 300, 500, 750],
    // Costs are initial log10 cost, log10 ratio, maximum level.
    costs: [[1, Math.log10(1.35), 20000], [2, Math.log10(4), 20000],
        [1.2, 4, 24], [1.5, 4, 24], [1.6, 4, 24], [2, 5, 24],
        [30, 16, 1000]],
    ambient: 300, hotCapacity: 2, coldCapacity: 3,
    // v0.2 deliberately explores idealized extreme-temperature engines.
    // radiationScale is a gameplay-scaled Stefan-Boltzmann coefficient (W/K^4).
    radiationScale: 1e-13, physicalStep: 0.5, transientWindow: 600
};
var currency, upgrades = [], milestones = [], load, stages;
var detailPage = 0;
var hot = 700, cold = 320, sigma = BigNumber.ZERO;
var researchTime = BigNumber.ZERO; // persistent statistical exploration, measured in game seconds
var stateVersion = 2;
var lastFlow = { qh: 0, qc: 0, w: 0, s: 0, eta: 0, carnot: 0, leak: 0, dump: 0 };
var lastRate = BigNumber.ZERO;
var labels = ["c_1", "c_2", "G", "P_H", "K_C", "\\varepsilon", "N"];
var titles = ["Production coefficient", "Replication coefficient", "Heat exchanger", "Furnace coupling", "Cooling capacity", "Engine craftsmanship", "Parallel engine fleet"];
var milestoneTitles = ["Entropy", "Entropy Recycling", "Advanced irreversibility", "Work scaling", "Cascade Engines", "Entropy exponent", "Statistical Mechanics", "Microstate amplification I", "Microstate amplification II", "Microstate amplification III"];
var unlocked = (i) => milestones[i].level > 0;
var level = (i) => upgrades[i].level;
var c1Value = () => Utils.getStepwisePowerSum(level(0), 2, 8, 0);
var c2Value = () => BigNumber.TWO.pow(level(1));
var c1Exponent = () => unlocked(2) ? 1.2 : (unlocked(0) ? 1.1 : 1);
var workExponent = () => unlocked(3) ? 1.2 : 1;
var entropyExponent = () => unlocked(1) ? (unlocked(5) ? 0.4 : 0.25) : 0;
var microExponent = () => unlocked(6) ? 0.5 + 0.15 * (milestones[7].level + milestones[8].level + milestones[9].level) : 0;
var fleetValue = () => unlocked(0) ? bMul(c2Value().pow(0.15), BigNumber.TWO.pow(unlocked(2) ? level(6) : 0)) : BigNumber.ONE;

// v0.2 physical model. Temperatures and rates are deliberately allowed to become
// fantastically large: this is an idealized theoretical engine, not a material model.
var sourceTemperature = (lv = level(3)) => 2000 * Math.pow(10, lv / 4);
var physicalParameters = () => {
    let u = 0.15 + 0.085 * load.level;
    let n = unlocked(4) ? 1 + stages.level : 1;
    let craft = level(5);
    let source = sourceTemperature();
    // Exponential hardware scaling makes the thermodynamic variables themselves grow.
    let g0 = 0.05 * Math.pow(1.75, level(2));
    let kc = 0.08 * Math.pow(2.0, level(4));
    let p = 0.04 * Math.pow(1.55, level(3));
    let baseCraft = 0.38 + 0.56 * (1 - Math.exp(-craft / 8));
    // Extreme temperature is hard: plasma/radiative engineering degrades relative
    // efficiency unless craftsmanship and cascade stages keep up.
    let thermalStress = Math.max(0, Math.log10(Math.max(1, source / 2000)));
    let stressPenalty = 0.22 * thermalStress * thermalStress / (1 + 0.16 * craft + 0.35 * (n - 1));
    let loadPenalty = 1.4 * u * u / (n * (1 + 0.05 * craft));
    let eps = Math.min(0.985, baseCraft / (1 + loadPenalty + stressPenalty));
    return { u: u, n: n, source: source,
        g: g0 * u / (1 + 0.12 * (n - 1)), p: p,
        k: unlocked(2) ? 0.002 : 0.006, kc: kc, eps: eps,
        thermalStress: thermalStress, baseCraft: baseCraft };
};
var flows = (th, tc, p) => {
    let qh = p.g * Math.max(0, th - tc), remaining = qh;
    let stageTemperatures = [th];
    for (let j = 1; j <= p.n; j++) {
        let a = th * Math.pow(tc / th, (j - 1) / p.n);
        let b = th * Math.pow(tc / th, j / p.n);
        remaining *= 1 - p.eps * (1 - b / a);
        stageTemperatures.push(b);
    }
    let qc = remaining, w = qh - qc, carnot = Math.max(0, 1 - tc / th);
    // Stefan-Boltzmann-like radiative loss. It is intentionally gameplay-scaled,
    // but preserves the crucial T^4 dependence that makes extreme heat expensive.
    let radiation = CONFIG.radiationScale * Math.max(0, Math.pow(th, 4) - Math.pow(CONFIG.ambient, 4));
    return { qh: qh, qc: qc, w: w, s: Math.max(0, qc / tc - qh / th),
        eta: qh > 0 ? w / qh : 0, carnot: carnot,
        leak: p.k * (th - tc), radiation: radiation,
        dump: p.kc * Math.max(0, tc - CONFIG.ambient), stageTemperatures: stageTemperatures };
};
// Nonlinear backward Euler.  At extreme temperature the T^4 radiation term
// is stiff; a single frozen linearization can alternate between a very hot and
// a nearly-ambient state.  Iterate the implicit solve with damping instead.
// sigma*(T^4-T0^4) = K_rad(T)*(T-T0) exactly, with
// K_rad(T)=sigma*(T+T0)*(T^2+T0^2).
var physicalStep = (dt, p) => {
    let oldHot = hot, oldCold = cold;
    let h = CONFIG.hotCapacity, c = CONFIG.coldCapacity;
    let guessHot = hot, guessCold = cold;
    // More iterations are used for large offline equilibration steps; ordinary
    // 0.5 s real-time steps remain inexpensive.
    let iterations = dt > 2 ? 20 : 8;
    for (let iter = 0; iter < iterations; iter++) {
        let gf = flows(guessHot, guessCold, p);
        let exchange = p.g + p.k;
        let rejection = p.g * (1 - gf.eta) + p.k;
        let t0 = CONFIG.ambient;
        let krad = CONFIG.radiationScale *
            (guessHot + t0) * (guessHot * guessHot + t0 * t0);
        let a = h / dt + p.p + exchange + krad, b = -exchange;
        let cc = -rejection, d = c / dt + rejection + p.kc;
        let rh = h / dt * oldHot + p.p * p.source + krad * t0;
        let rc = c / dt * oldCold + p.kc * t0;
        let determinant = a * d - b * cc;
        let nextHot = Math.max(t0 + 1e-6, (rh * d - b * rc) / determinant);
        let nextCold = Math.max(t0, Math.min(nextHot - 1e-6, (a * rc - cc * rh) / determinant));
        // Damping makes the fixed-point iteration robust in the radiation-
        // dominated regime without changing the implicit equations.
        guessHot = 0.5 * guessHot + 0.5 * nextHot;
        guessCold = 0.5 * guessCold + 0.5 * nextCold;
    }
    hot = guessHot;
    cold = Math.max(CONFIG.ambient, Math.min(hot - 1e-6, guessCold));
    lastFlow = flows(hot, cold, p);
    return lastFlow;
};
var economicCoefficient = () => bMul(bMul(theory.publicationMultiplier,
    c1Value().pow(c1Exponent())), c2Value());
// Entropy is deliberately sub-exponential as an economic multiplier.
// v0.2 used (1+Sigma/100)^beta; once Sigma became astronomical this could
// skip the entire post-Entropy game in minutes.  We instead reward orders of
// magnitude of accumulated entropy: F_S = (1 + log10(1+Sigma/100))^(2 beta).
var entropyLog = (s) => bAdd(BigNumber.ONE, bDiv(s, BN(100))).log10();
var entropyFactor = (s) => bAdd(BigNumber.ONE, entropyLog(s)).pow(2 * entropyExponent());
// S_eff/kB = ln(1+Sigma/100): coarse-grained opportunity, NOT literal exp(total waste heat).
// log10 Omega_eff stays a BigNumber. No conversion to JS Number, no exp(Number).
var explorationPower = () => 8 + 2 * (milestones[7].level + milestones[8].level + milestones[9].level);
var microstateFactor = (s, research = researchTime) => {
    let logOmega = bMul(bAdd(BigNumber.ONE, bDiv(s, BN(100))).log10(), BN(microExponent()));
    let explored = bMul(bAdd(BigNumber.ONE, bDiv(research, BN(3600))).log10(), BN(explorationPower()));
    return logOmega.min(explored).exp10();
};
var rateAt = (f, s, coefficient, research = researchTime) => bMul(bMul(bMul(coefficient,
    BN(f.w / 10).pow(workExponent())), entropyFactor(s)), microstateFactor(s, research));
var accumulate = (dt, f, coefficient, fleet) => {
    let ds = unlocked(0) ? bMul(bMul(fleet, BN(f.s)), dt) : BigNumber.ZERO;
    // Midpoint entropy quadrature avoids using end-of-interval entropy retroactively.
    let middle = bAdd(sigma, bMul(ds, BN(0.5)));
    let researchDelta = unlocked(6) && f.s > 0 && level(0) > 0 ? dt : BigNumber.ZERO;
    lastRate = rateAt(f, middle, coefficient, bAdd(researchTime, bMul(researchDelta, BN(0.5))));
    researchTime = bAdd(researchTime, researchDelta);
    currency.value = bAdd(currency.value, bMul(lastRate, dt));
    sigma = bAdd(sigma, ds);
};
var tick = (elapsedTime, multiplier) => {
    if (!Number.isFinite(elapsedTime) || !Number.isFinite(multiplier) || elapsedTime <= 0 || multiplier <= 0) return;
    // Multiplication is BigNumber-safe even for unusually large valid input products.
    let dt = bMul(BN(elapsedTime), BN(multiplier));
    let transient = dt.min(BN(CONFIG.transientWindow)).toNumber();
    let p = physicalParameters(), coefficient = economicCoefficient(), fleet = fleetValue();
    let count = Math.ceil(transient / CONFIG.physicalStep), step = transient / count;
    for (let j = 0; j < count; j++) {
        accumulate(BN(step), physicalStep(step, p), coefficient, fleet);
    }
    let tail = bSub(dt, BN(transient));
    if (tail.sign > 0) {
        // Fixed-work offline path: equilibrate with large implicit steps, then integrate
        // resource multipliers by bounded quadrature, not one giant Euler step.
        for (let j = 0; j < 24; j++) physicalStep(10000, p);
        // Fixed 256-point midpoint quadrature in BigNumber time. The two affine
        // resource powers (entropy and research time) have bounded exponents;
        // min(entropy opportunities, explored states) introduces only one kink.
        // Work does not scale with offline duration; no giant end-value Euler step.
        let part = bDiv(tail, BN(256));
        for (let j = 0; j < 256; j++) accumulate(part, lastFlow, coefficient, fleet);
        lastRate = rateAt(lastFlow, sigma, coefficient);
    }
    theory.invalidateTertiaryEquation();
};
var refresh = () => {
    for (let i = 0; i < milestones.length; i++) milestones[i].isAvailable = i === 0 || unlocked(i - 1);
    upgrades[6].isAvailable = unlocked(2);
    stages.isAvailable = unlocked(4);
    theory.invalidatePrimaryEquation();
    theory.invalidateSecondaryEquation();
    theory.invalidateTertiaryEquation();
};
var hardwareValue = (i, lv) => {
    if (i === 2) return "G_0=" + (0.05 * Math.pow(1.75, lv)).toExponential(2) + " W/K";
    if (i === 3) return "T_source=" + sourceTemperature(lv).toExponential(2) + " K";
    if (i === 4) return "K_C=" + (0.08 * Math.pow(2, lv)).toExponential(2) + " W/K";
    return "Zero-stress craftsmanship=" + (0.38 + 0.56 * (1 - Math.exp(-lv / 8))).toFixed(3);
};
var upgradeValue = (i, lv) => {
    if (i === 0) return Utils.getStepwisePowerSum(lv, 2, 8, 0).toString(2);
    if (i === 1) return BigNumber.TWO.pow(lv).toString(2);
    if (i === 6) return BigNumber.TWO.pow(lv).toString(2) + " (additional sampling fleet)";
    return hardwareValue(i, lv);
};
var init = () => {
    currency = theory.createCurrency();
    CONFIG.costs.forEach((cost, i) => {
        let model = new ExponentialCost(pow10(cost[0]), cost[1] * Math.log2(10));
        if (i === 0) model = new FirstFreeCost(model);
        let upgrade = theory.createUpgrade(i, currency, model);
        upgrade.maxLevel = cost[2];
        upgrade.getDescription = (_) => i < 2 ? Utils.getMath(labels[i] + "=" + upgradeValue(i, upgrade.level)) : titles[i] + " [" + upgrade.level + "]";
        upgrade.getInfo = (amount) => upgradeValue(i, upgrade.level) + " → " + upgradeValue(i, Math.min(upgrade.maxLevel, upgrade.level + amount));
        upgrades.push(upgrade);
    });
    load = theory.createUpgrade(20, currency, new FreeCost());
    load.maxLevel = 10; load.isAutoBuyable = false; load.canBeRefunded = (_) => true;
    load.getDescription = (_) => "Engine load: " + (15 + 8.5 * load.level).toFixed(1) + "%";
    load.info = "Free and refundable. More load increases heat throughput, but lowers relative efficiency and creates more rejected heat. At extreme temperature this can overwhelm cooling.";
    load.level = 5;
    stages = theory.createUpgrade(21, currency, new FreeCost());
    stages.maxLevel = 3; stages.isAutoBuyable = false; stages.canBeRefunded = (_) => true;
    stages.getDescription = (_) => "Cascade stages: " + (1 + stages.level);
    stages.info = "Free topology selector. Cascade stages recover rejected heat and reduce high-temperature stress per stage. They add exchanger resistance and never exceed the Carnot limit.";
    theory.createPublicationUpgrade(0, currency, pow10(8));
    theory.createBuyAllUpgrade(1, currency, pow10(12));
    theory.createAutoBuyerUpgrade(2, currency, pow10(20));
    // CONFIG.milestones is expressed as log10(rho) targets.  Since tau=rho^tauPower,
    // a target rho=10^x corresponds to tau=10^(tauPower*x).  v0.2 accidentally
    // returned tauPower*x itself, making every milestone vastly too cheap.
    theory.setMilestoneCost(new CustomCost((total) => pow10(CONFIG.tauPower * (CONFIG.milestones[total] || 1000000))));
    milestoneTitles.forEach((title, i) => {
        let m = theory.createMilestoneUpgrade(i, 1);
        m.description = title;
        m.info = ["Track extensive entropy across the sampling fleet; raise c1 exponent to 1.1.", "Use orders of magnitude of waste-history as a research resource, not recovered work.",
            "Reduce heat leaks, improve c1 scaling, and unlock parallel fleets.", "Raise the normalized work exponent to 1.2.",
            "Choose one to four heat-engine stages.", "Raise the logarithmic entropy exponent from 0.25 to 0.4.",
            "Explore microstates over research time. Opportunity is limited by both entropy and exploration; research time persists after publication.", "Raise opportunity exponent by 0.15 and exploration exponent by 2.",
            "Raise opportunity exponent by 0.15 and exploration exponent by 2.", "Raise opportunity exponent by 0.15 and exploration exponent by 2."][i];
        // v0.1 irreversible ordered milestones prevent respec banking of entropy.
        m.canBeRefunded = (_) => false;
        m.boughtOrRefunded = (_) => refresh();
        milestones.push(m);
    });
    const stories = [
        ["Heat", "The heat source is no longer limited to ordinary furnaces. Push it from thousands to millions of kelvin, but every hotter regime creates a new thermal bottleneck.", () => level(0) > 0],
        ["Carnot", "No engine converts all incoming heat to work. At extreme temperature, load and thermal stress punish relative efficiency; engineering is what unlocks the next power scale.", () => level(5) > 0],
        ["Irreversibility", "Rejected heat carries entropy. The engine conserves energy while its entropy production remains nonnegative.", () => unlocked(0)],
        ["Recycling knowledge", "Waste cannot become free work. Its accumulated history can guide better manufacturing: entropy becomes an economic research resource.", () => unlocked(1)],
        ["A cascade", "One stage's rejected heat feeds the next. Added stages help real engines but cannot beat a reversible Carnot engine.", () => unlocked(4)],
        ["Statistical mechanics", "S = kB ln Omega counts equilibrium microstates. Here entropy bounds potential opportunities and finite research time bounds explored states; temperature still remains ordinary.", () => unlocked(6)]
    ];
    stories.forEach((s, i) => theory.createStoryChapter(i, s[0], s[1], s[2]));
    theory.primaryEquationHeight = 65; theory.primaryEquationScale = 0.85; theory.secondaryEquationHeight = 110; theory.secondaryEquationScale = 0.85;
    refresh();
};
// Renderer compatibility: keep symbol glyphs literal so Greek command lookup
// cannot fail on the device. Use only the basic commands seen in Official CTs:
// \dot{...}, \begin{matrix}, \end{matrix}, \text{...}, \log and \;.
// In particular, never use an unbraced accent (\dot\rho), \rm declarations,
// array column specifications, escaped braces, or a naked spacing command.
// This block formats the existing model; it does not change any calculations.
// Command audit (all commands formerly returned by these three getters):
// rho, eta, varepsilon, Sigma, Omega, gamma -> literal ρ, η, ε, Σ, Ω, γ.
// dot -> explicit braced argument; rm -> text with an explicit braced argument.
// begin/end array{ll} -> begin/end matrix; row separators and & stay in matrix.
// quad, comma-space, backslash-space -> semicolon-space; ge -> literal ≥.
// log -> retained with parenthesized argument; min -> text{min}.
// Escaped left/right braces -> ordinary parentheses.
// Source examples: conicgames/theory-sdk/CustomTheory.js (braced dot);
// conicgames/custom-theories/official/ConvergentsToSqrt2.js (matrix, log, ;);
// official/EulersFormula.js and MagneticFields.js (text).
// Greek macros are NOT universally unsupported: rho is in the SDK example.
// Literal glyphs avoid macro lookup on the reporting device. The SDK does not
// expose its device renderer, so headless checks do not replace a device test.
var getPrimaryEquation = () => "\\dot{ρ}=M c_1^{" + c1Exponent() + "}c_2(\\dot{W}/10)^{" + workExponent() + "}" +
    (unlocked(1) ? "(1+\\log_{10}(1+Σ/100))^{" + (2 * entropyExponent()).toFixed(2) + "}" : "") +
    (unlocked(6) ? "Ω_{\\text{eff}}" : "");
var getSecondaryEquation = () => {
    theory.secondaryEquationHeight = unlocked(6) ? 155 : 100;
    return "\\begin{matrix}η_C=1-T_C/T_H,\\;η=ε_{\\text{eff}}η_C" +
        "\\\\\\dot{W}=η\\dot{Q}_H,\\;\\dot{Q}_{\\text{rad}}=k_r(T_H^4-T_0^4)" +
        "\\\\\\dot{S}_{\\text{gen}}=\\dot{Q}_C/T_C-\\dot{Q}_H/T_H≥0" +
        (unlocked(6) ? "\\\\\\log_{10}(Ω_{\\text{eff}})=\\text{min}(γ L_{Σ},a L_t)" +
            "\\\\L_{Σ}=\\log_{10}(1+Σ/100)" +
            "\\\\L_t=\\log_{10}(1+t_s/3600)" : "") +
        "\\end{matrix}";
};
var fmtPhysical = (x, digits = 3) => {
    if (!Number.isFinite(x)) return "∞";
    let ax = Math.abs(x);
    if ((ax >= 1e4 || (ax > 0 && ax < 1e-2))) return x.toExponential(digits - 1);
    return x.toFixed(digits);
};
var getTertiaryEquation = () => {
    let p = physicalParameters(), f = flows(hot, cold, p);
    let pages = 4; detailPage = ((detailPage % pages) + pages) % pages;
    if (detailPage === 0) return "\\begin{matrix}\\text{ENGINE}\\\\T_H=" + fmtPhysical(hot) + "\\;\\text{K}&T_C=" + fmtPhysical(cold) + "\\;\\text{K}\\\\" +
        "T_s=" + fmtPhysical(p.source) + "\\;\\text{K}&η=" + f.eta.toFixed(3) + "\\\\" +
        "\\dot{Q}_H=" + fmtPhysical(f.qh) + "\\;\\text{W}&\\dot{W}=" + fmtPhysical(f.w) + "\\;\\text{W}\\\\" +
        "η_C=" + f.carnot.toFixed(3) + "&ε_{\\text{eff}}=" + (f.carnot > 0 ? (f.eta/f.carnot).toFixed(3) : "0") + "\\end{matrix}";
    if (detailPage === 1) return "\\begin{matrix}\\text{LOSSES / COOLING}\\\\\\dot{Q}_C=" + fmtPhysical(f.qc) + "\\;\\text{W}&\\dot{Q}_{\\text{rad}}=" + fmtPhysical(f.radiation) + "\\;\\text{W}\\\\" +
        "\\dot{Q}_{\\text{leak}}=" + fmtPhysical(f.leak) + "\\;\\text{W}&\\dot{Q}_{\\text{cool}}=" + fmtPhysical(f.dump) + "\\;\\text{W}\\\\" +
        "\\dot{S}_{\\text{gen}}=" + fmtPhysical(f.s) + "\\;\\text{W/K}&Σ=" + sigma.toString(2) + "\\\\" +
        "u=" + p.u.toFixed(3) + "&\\text{stress}=" + p.thermalStress.toFixed(3) + "\\end{matrix}";
    if (detailPage === 2) {
        let temps = "T_H=" + fmtPhysical(hot) + "\\;\\text{K}";
        for (let j = 1; j < p.n; j++) temps += "\\\\T_" + j + "=" + fmtPhysical(f.stageTemperatures[j]) + "\\;\\text{K}";
        temps += "\\\\T_C=" + fmtPhysical(cold) + "\\;\\text{K}";
        return "\\begin{matrix}\\text{CASCADE}\\\\n=" + p.n + "&ε_{\\text{stage}}=" + p.eps.toFixed(3) + "\\\\" + temps + "\\end{matrix}";
    }
    let ls = bAdd(BigNumber.ONE, bDiv(sigma, BN(100))).log10();
    let lt = bAdd(BigNumber.ONE, bDiv(researchTime, BN(3600))).log10();
    return "\\begin{matrix}\\text{STATISTICAL MECHANICS}\\\\Σ=" + sigma.toString(2) + "&t_s=" + researchTime.toString(2) + "\\;\\text{s}\\\\" +
        "L_{Σ}=" + ls.toString(2) + "&L_t=" + lt.toString(2) + "\\\\" +
        "γ=" + microExponent().toFixed(2) + "&a=" + explorationPower() + "\\\\Ω_{\\text{eff}}=" + microstateFactor(sigma).toString(2) + "&N=" + fleetValue().toString(2) + "\\end{matrix}";
};

// Read-only dashboard. These plain labels bypass the equation renderer entirely.
// Snapshot values are evaluated on demand; no currency/state is narrowed to Number.
// Physical rates below use the current hardware at the current temperatures.
// lastRate remains separately visible as the rate sampled by the last tick.
var getVariableRows = () => {
    let p = physicalParameters(), f = flows(hot, cold, p), n = fleetValue();
    let ls = bAdd(BigNumber.ONE, bDiv(sigma, BN(100))).log10();
    let lt = bAdd(BigNumber.ONE, bDiv(researchTime, BN(3600))).log10();
    let opportunity = bMul(ls, BN(microExponent()));
    let explored = bMul(lt, BN(explorationPower()));
    let omega = microstateFactor(sigma);
    let ph = p.p * (p.source - hot);
    let rows = [];
    let add = (section, symbol, value, meaning) => rows.push({
        section: section, symbol: symbol, value: value, meaning: meaning
    });
    let big = (x) => x.toString(3);
    let small = (x) => x.toFixed(4);
    let on = (i) => unlocked(i) ? "解禁" : "未解禁";
    add("生産・publication", "ρ", big(currency.value), "現在の通貨");
    add("生産・publication", "dρ/dt (last)", big(lastRate), "最後のtickで積分に使った生産率");
    add("生産・publication", "dρ/dt (now)", big(rateAt(f, sigma, economicCoefficient())), "現在の状態での瞬間生産率");
    add("生産・publication", "τ", big(getTau()), "現在のρから計算するpublication値");
    add("生産・publication", "τ (best)", big(theory.tau), "ゲームが保持する最高τ");
    add("生産・publication", "M", big(theory.publicationMultiplier), "現在有効なpublication倍率");
    add("生産・publication", "M (next)", big(getPublicationMultiplier(getTau())), "現在のτに対応する倍率（確定前）");
    add("生産・publication", "c₁", big(c1Value()), "stepwise生産係数");
    add("生産・publication", "c₂", big(c2Value()), "指数型生産係数");
    add("生産・publication", "c₁ exponent", small(c1Exponent()), "c₁の指数");
    add("生産・publication", "α", small(workExponent()), "仕事項の指数");
    add("生産・publication", "β", small(entropyExponent()), "entropy項の指数");
    add("生産・publication", "M c₁^x c₂", big(economicCoefficient()), "entropy・仕事・microstateを除く係数");
    add("生産・publication", "Wdot/10", small(f.w / 10), "正規化した仕事率");
    add("生産・publication", "(Wdot/10)^α", big(BN(f.w / 10).pow(workExponent())), "仕事の生産因子");
    add("生産・publication", "τ exponent", small(CONFIG.tauPower), "τの指数");
    add("生産・publication", "M exponent", small(CONFIG.pubPower), "publication倍率の指数");
    add("熱浴・熱流（1機あたり）", "T_H", small(hot) + " K", "高温熱浴");
    add("熱浴・熱流（1機あたり）", "T_C", small(cold) + " K", "低温熱浴");
    add("熱浴・熱流（1機あたり）", "T_H - T_C", small(hot - cold) + " K", "熱浴の温度差");
    add("熱浴・熱流（1機あたり）", "T₀", small(CONFIG.ambient) + " K", "外部環境");
    add("熱浴・熱流（1機あたり）", "T_furnace", small(p.source) + " K", "upgradeで上昇する理論熱源");
    add("熱浴・熱流（1機あたり）", "C_H", small(CONFIG.hotCapacity) + " J/K", "高温側の熱容量");
    add("熱浴・熱流（1機あたり）", "C_C", small(CONFIG.coldCapacity) + " J/K", "低温側の熱容量");
    add("熱浴・熱流（1機あたり）", "P_H", small(ph) + " W", "炉から入る実際の加熱率");
    add("熱浴・熱流（1機あたり）", "Qdot_H", small(f.qh) + " W", "機関に入る熱流");
    add("熱浴・熱流（1機あたり）", "Wdot", small(f.w) + " W", "機関の仕事率");
    add("熱浴・熱流（1機あたり）", "Qdot_C", small(f.qc) + " W", "機関から捨てる熱流");
    add("熱浴・熱流（1機あたり）", "K(T_H - T_C)", small(f.leak) + " W", "直接の熱漏れ");
    add("熱浴・熱流（1機あたり）", "Qdot_rad", small(f.radiation) + " W", "高温側から環境へのT^4放射損失");
    add("熱浴・熱流（1機あたり）", "K_C(T_C - T₀)", small(f.dump) + " W", "外部環境へ放出する熱流");
    add("熱浴・熱流（1機あたり）", "dT_H/dt", small((ph - f.qh - f.leak - f.radiation) / CONFIG.hotCapacity) + " K/s", "モデルの瞬間温度変化率");
    add("熱浴・熱流（1機あたり）", "dT_C/dt", small((f.qc + f.leak - f.dump) / CONFIG.coldCapacity) + " K/s", "モデルの瞬間温度変化率");
    add("負荷・効率・cascade", "u", small(p.u), "有効な負荷（割合）");
    add("負荷・効率・cascade", "load level", "" + load.level, "負荷セレクタのレベル");
    add("負荷・効率・cascade", "G₀", small(0.05 * Math.pow(1.75, level(2))) + " W/K", "熱交換器の基礎係数");
    add("負荷・効率・cascade", "G", small(p.g) + " W/K", "負荷・cascade抵抗を含む熱交換係数");
    add("負荷・効率・cascade", "P coupling", small(p.p) + " W/K", "炉との熱結合係数");
    add("負荷・効率・cascade", "K", small(p.k) + " W/K", "熱漏れ係数");
    add("負荷・効率・cascade", "K_C", small(p.kc) + " W/K", "冷却係数");
    add("負荷・効率・cascade", "ε₀", small(p.baseCraft), "無負荷でのcraftsmanship");
    add("負荷・効率・cascade", "thermal stress", small(p.thermalStress), "log10(T_source/2000)に基づく高温ペナルティ");
    add("負荷・効率・cascade", "ε (stage)", small(p.eps), "負荷損失を含む1段の相対効率");
    add("負荷・効率・cascade", "η_C", small(f.carnot), "全温度差に対するCarnot効率");
    add("負荷・効率・cascade", "η", small(f.eta), "全機関の実際の効率");
    add("負荷・効率・cascade", "ε_eff", small(f.carnot > 0 ? f.eta / f.carnot : 0), "η/η_C（全段を含む）");
    add("負荷・効率・cascade", "n", "" + p.n, "有効なcascade段数 / " + on(4));
    add("負荷・効率・cascade", "stages level", "" + stages.level, "段数セレクタのレベル");
    for (let j = 1; j < p.n; j++)
        add("負荷・効率・cascade", "T_" + j, small(f.stageTemperatures[j]) + " K", "cascadeの中間熱浴");
    add("entropy・fleet", "N", big(n), "entropyを記録する有効fleet数");
    add("entropy・fleet", "2^(fleet level)", big(BigNumber.TWO.pow(level(6))), "追加fleet係数 / " + on(2));
    add("entropy・fleet", "Sdot_gen", small(f.s) + " W/K", "1機あたりのentropy生成率");
    add("entropy・fleet", "dΣ/dt", big(unlocked(0) ? bMul(n, BN(f.s)) : BigNumber.ZERO) + " W/K", "実際に累積する全fleetの生成率 / " + on(0));
    add("entropy・fleet", "Σ", big(sigma) + " J/K", "累積entropy");
    add("entropy・fleet", "1 + Σ/100", big(bAdd(BigNumber.ONE, bDiv(sigma, BN(100)))), "正規化したentropy資源");
    add("entropy・fleet", "(1 + log10(1+Σ/100))^(2β)", big(entropyFactor(sigma)), "entropy生産因子 / " + on(1));
    add("statistical mechanics", "t_s", big(researchTime) + " s", "publication後も保持する探索時間 / " + on(6));
    add("statistical mechanics", "γ", small(microExponent()), "entropy機会の指数");
    add("statistical mechanics", "a", "" + explorationPower(), "探索時間の指数 / " + on(6));
    add("statistical mechanics", "L_Σ", big(ls), "log10(1 + Σ/100)");
    add("statistical mechanics", "L_t", big(lt), "log10(1 + t_s/3600)");
    add("statistical mechanics", "γ L_Σ", big(opportunity), "entropyによるmicrostate上限");
    add("statistical mechanics", "a L_t", big(explored), "探索時間によるmicrostate上限");
    add("statistical mechanics", "log10 Ω_eff", big(opportunity.min(explored)), "2つの上限の小さい方");
    add("statistical mechanics", "Ω_eff", big(omega), "実際のmicrostate生産因子 / " + on(6));
    for (let i = 0; i < upgrades.length; i++)
        add("upgradeレベル", labels[i].replace("\\varepsilon", "ε"), "" + level(i), titles[i]);
    for (let i = 0; i < milestones.length; i++)
        add("milestone", milestoneTitles[i], "" + milestones[i].level, on(i));
    return rows;
};
var getVariableText = () => {
    let rows = getVariableRows(), section = "", lines = [];
    for (let i = 0; i < rows.length; i++) {
        let r = rows[i];
        if (r.section !== section) {
            section = r.section;
            lines.push("\n" + section + "\n");
        }
        lines.push(r.symbol + " = " + r.value + "\n" + r.meaning + "\n");
    }
    return lines.join("\n");
};
var showAllVariables = () => {
    let popup = ui.createPopup({
        title: "全変数・現在値",
        closeOnBackButtonClicked: true,
        closeOnBackgroundClicked: true,
        content: ui.createStackLayout({
            children: [
                ui.createScrollView({
                    heightRequest: Math.max(200, ui.screenHeight * 0.65),
                    content: ui.createLabel({ text: () => getVariableText(), fontSize: 14 })
                }),
                ui.createButton({ text: "閉じる", onClicked: () => popup.hide() })
            ]
        })
    });
    popup.show();
};
var changeDetailPage = (delta) => {
    detailPage = (detailPage + delta + 4) % 4;
    theory.invalidateTertiaryEquation();
};
var getEquationOverlay = () => ui.createGrid({
    inputTransparent: true, cascadeInputTransparent: false,
    children: [
        ui.createButton({
            text: "‹", fontSize: 20, widthRequest: 44, heightRequest: 30,
            horizontalOptions: LayoutOptions.START, verticalOptions: LayoutOptions.END,
            onClicked: () => changeDetailPage(-1)
        }),
        ui.createButton({
            text: "全変数", fontSize: 12, widthRequest: 82, heightRequest: 30,
            horizontalOptions: LayoutOptions.START, verticalOptions: LayoutOptions.START,
            onClicked: () => showAllVariables()
        }),
        ui.createButton({
            text: "›", fontSize: 20, widthRequest: 44, heightRequest: 30,
            horizontalOptions: LayoutOptions.END, verticalOptions: LayoutOptions.END,
            onClicked: () => changeDetailPage(1)
        })
    ]
});

var getTau = () => currency.value.pow(CONFIG.tauPower);
var getCurrencyFromTau = (tau) => [tau.max(BigNumber.ONE).pow(1 / CONFIG.tauPower), currency.symbol];
var getPublicationMultiplier = (tau) => tau.pow(CONFIG.pubPower).max(BigNumber.ONE);
var getPublicationMultiplierFormula = (symbol) => symbol + "^{" + CONFIG.pubPower + "}";
var get2DGraphValue = () => bAdd(BigNumber.ONE, currency.value).log10().min(BN(1e6)).toNumber();
var getInternalState = () => JSON.stringify({ version: stateVersion, hot: hot, cold: cold, sigma: sigma.toBase64String(), researchTime: researchTime.toBase64String() });
var setInternalState = (state) => {
    if (!state) return;
    try {
        let s = JSON.parse(state);
        if (s.version !== stateVersion) return;
        if (Number.isFinite(s.hot) && Number.isFinite(s.cold) && s.cold >= CONFIG.ambient && s.hot >= s.cold && s.hot <= 1e250) {
            hot = s.hot; cold = s.cold;
        }
        let parsed = BigNumber.fromBase64String(s.sigma);
        if (parsed.sign >= 0 && Number.isFinite(parsed.exponent)) sigma = parsed;
        if (s.researchTime) {
            let rt = BigNumber.fromBase64String(s.researchTime);
            if (rt.sign >= 0 && Number.isFinite(rt.exponent)) researchTime = rt;
        }
    } catch (_) { /* Corrupt/older saves retain a safe initial state. */ }
    lastFlow = flows(hot, cold, physicalParameters());
    refresh();
};
var postPublish = () => {
    hot = 700; cold = 320; detailPage = 0; sigma = BigNumber.ZERO; lastRate = BigNumber.ZERO;
    load.level = 5; stages.level = 0;
    lastFlow = flows(hot, cold, physicalParameters());
    refresh();
};
init();
