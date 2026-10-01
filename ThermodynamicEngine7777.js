import { ExponentialCost, FirstFreeCost, FreeCost, CustomCost } from "./api/Costs";
import { BigNumber } from "./api/BigNumber";
import { theory } from "./api/Theory";
import { Utils } from "./api/Utils";
import { ui } from "./api/ui/UI";
import { LayoutOptions } from "./api/ui/properties/LayoutOptions";

var id = "thermodynamic_engine";
var name = "Thermodynamic Engine";
var description = "Build a finite-temperature heat engine, balance load against efficiency, and turn irreversibility into statistical opportunity. Prototype v0.1.";
var authors = "75yoshiishion-ship-it, developed with Codex";
var version = 2;
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
    furnace: 2000, ambient: 300, hotCapacity: 2, coldCapacity: 3,
    physicalStep: 0.5, transientWindow: 600
};
var currency, upgrades = [], milestones = [], load, stages;
var hot = 700, cold = 320, sigma = BigNumber.ZERO;
var researchTime = BigNumber.ZERO; // persistent statistical exploration, measured in game seconds
var stateVersion = 1;
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

// Per-engine quantities are in W, K, J/K. The furnace is a finite 2000 K source.
var physicalParameters = () => {
    let u = 0.15 + 0.085 * load.level;
    let n = unlocked(4) ? 1 + stages.level : 1;
    return { u: u, n: n, g: 0.05 * (1 + 0.25 * level(2)) * u / (1 + 0.18 * (n - 1)),
        p: 0.04 * (1 + 0.35 * level(3)), k: unlocked(2) ? 0.004 : 0.008,
        kc: 0.08 * (1 + 0.4 * level(4)),
        eps: (0.38 + 0.5 * (1 - Math.exp(-level(5) / 8))) /
            (1 + 1.4 * u * u / (n * (1 + 0.04 * level(5)))) };
};
var flows = (th, tc, p) => {
    let qh = p.g * Math.max(0, th - tc), remaining = qh;
    let stageTemperatures = [th];
    // Geometric temperature spacing, each stage receives previous rejected heat.
    for (let j = 1; j <= p.n; j++) {
        let a = th * Math.pow(tc / th, (j - 1) / p.n);
        let b = th * Math.pow(tc / th, j / p.n);
        remaining *= 1 - p.eps * (1 - b / a);
        stageTemperatures.push(b);
    }
    let qc = remaining, w = qh - qc, carnot = 1 - tc / th;
    return { qh: qh, qc: qc, w: w, s: Math.max(0, qc / tc - qh / th),
        eta: qh > 0 ? w / qh : 0, carnot: carnot,
        leak: p.k * (th - tc), dump: p.kc * (tc - CONFIG.ambient),
        stageTemperatures: stageTemperatures };
};
// Positivity-preserving backward Euler with efficiency frozen at the old state.
// No post-hoc temperature clamp: the passive 2x2 system preserves 300<=TC<=TH<=2000.
var physicalStep = (dt, p) => {
    let f = flows(hot, cold, p), h = CONFIG.hotCapacity, c = CONFIG.coldCapacity;
    let exchange = p.g + p.k, rejection = p.g * (1 - f.eta) + p.k;
    let a = h / dt + p.p + exchange, b = -exchange;
    let cc = -rejection, d = c / dt + rejection + p.kc;
    let rh = h / dt * hot + p.p * CONFIG.furnace;
    let rc = c / dt * cold + p.kc * CONFIG.ambient;
    let determinant = a * d - b * cc;
    hot = (rh * d - b * rc) / determinant;
    cold = (a * rc - cc * rh) / determinant;
    lastFlow = flows(hot, cold, p);
    return lastFlow;
};
var economicCoefficient = () => bMul(bMul(theory.publicationMultiplier,
    c1Value().pow(c1Exponent())), c2Value());
var entropyFactor = (s) => bAdd(BigNumber.ONE, bDiv(s, BN(100))).pow(entropyExponent());
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
    if (i === 2) return "G_0=" + (0.05 * (1 + 0.25 * lv)).toFixed(3) + " W/K";
    if (i === 3) return "P_H=" + (0.04 * (1 + 0.35 * lv)).toFixed(3) + "(2000-T_H) W";
    if (i === 4) return "K_C=" + (0.08 * (1 + 0.4 * lv)).toFixed(3) + " W/K";
    return "Zero-load craftsmanship=" + (0.38 + 0.5 * (1 - Math.exp(-lv / 8))).toFixed(3);
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
    load.info = "Free and refundable. More load extracts heat faster, but lowers craftsmanship efficiency and collapses the temperature gap. Recycling can reward the extra entropy.";
    load.level = 5;
    stages = theory.createUpgrade(21, currency, new FreeCost());
    stages.maxLevel = 3; stages.isAutoBuyable = false; stages.canBeRefunded = (_) => true;
    stages.getDescription = (_) => "Cascade stages: " + (1 + stages.level);
    stages.info = "Free topology selector. Stages recover rejected heat and reduce per-stage dissipation, but add heat-exchanger resistance. Ideal Carnot efficiency is never exceeded.";
    theory.createPublicationUpgrade(0, currency, pow10(8));
    theory.createBuyAllUpgrade(1, currency, pow10(12));
    theory.createAutoBuyerUpgrade(2, currency, pow10(20));
    theory.setMilestoneCost(new CustomCost((total) => BN(CONFIG.tauPower * (CONFIG.milestones[total] || 1000000))));
    milestoneTitles.forEach((title, i) => {
        let m = theory.createMilestoneUpgrade(i, 1);
        m.description = title;
        m.info = ["Track extensive entropy across the sampling fleet; raise c1 exponent to 1.1.", "Use waste-history as a research resource, not recovered work.",
            "Reduce heat leaks, improve c1 scaling, and unlock parallel fleets.", "Raise the normalized work exponent to 1.2.",
            "Choose one to four heat-engine stages.", "Raise entropy exponent from 0.25 to 0.4.",
            "Explore microstates over research time. Opportunity is limited by both entropy and exploration; research time persists after publication.", "Raise opportunity exponent by 0.15 and exploration exponent by 2.",
            "Raise opportunity exponent by 0.15 and exploration exponent by 2.", "Raise opportunity exponent by 0.15 and exploration exponent by 2."][i];
        // v0.1 irreversible ordered milestones prevent respec banking of entropy.
        m.canBeRefunded = (_) => false;
        m.boughtOrRefunded = (_) => refresh();
        milestones.push(m);
    });
    const stories = [
        ["Heat", "A finite furnace supplies energy. Increasing throughput is useful only if heating and cooling can sustain the temperature gap.", () => level(0) > 0],
        ["Carnot", "No engine converts all incoming heat to work. Load makes irreversible losses worse; lower load can produce more useful work.", () => level(5) > 0],
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
    (unlocked(1) ? "(1+Σ/100)^{" + entropyExponent() + "}" : "") +
    (unlocked(6) ? "Ω_{\\text{eff}}" : "");
var getSecondaryEquation = () => {
    theory.secondaryEquationHeight = unlocked(6) ? 140 : 80;
    return "\\begin{matrix}η_C=1-T_C/T_H,\\;η=ε_{\\text{eff}}η_C" +
        "\\\\\\dot{W}=η\\dot{Q}_H" +
        "\\\\\\dot{S}_{\\text{gen}}=\\dot{Q}_C/T_C-\\dot{Q}_H/T_H≥0" +
        (unlocked(6) ? "\\\\\\log_{10}(Ω_{\\text{eff}})=\\text{min}(γ L_{Σ},a L_t)" +
            "\\\\L_{Σ}=\\log_{10}(1+Σ/100)" +
            "\\\\L_t=\\log_{10}(1+t_s/3600)" : "") +
        "\\end{matrix}";
};
var getTertiaryEquation = () => "\\begin{matrix}c_1=" + c1Value().toString(2) + "&c_2=" + c2Value().toString(2) + "\\\\" +
    "M=" + theory.publicationMultiplier.toString(2) + "&\\dot{ρ}=" + lastRate.toString(2) + "\\\\" +
    "T_H=" + hot.toFixed(1) + "\\;\\text{K}&T_C=" + cold.toFixed(1) + "\\;\\text{K}\\\\" +
    "η_C=" + lastFlow.carnot.toFixed(3) + "&η=" + lastFlow.eta.toFixed(3) + "\\\\" +
    "\\dot{W}=" + lastFlow.w.toFixed(2) + "\\;\\text{W}&\\dot{S}_{\\text{gen}}=" + lastFlow.s.toFixed(4) + "\\;\\text{W/K}\\\\" +
    "Σ=" + sigma.toString(2) + "&N=" + fleetValue().toString(2) +
    (unlocked(6) ? "\\\\t_s=" + researchTime.toString(1) + "\\;\\text{s}&γ=" + microExponent().toFixed(2) + ",a=" + explorationPower() : "") +
    "\\end{matrix}";

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
    let ph = p.p * (CONFIG.furnace - hot);
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
    add("熱浴・熱流（1機あたり）", "T_furnace", small(CONFIG.furnace) + " K", "有限温度の炉");
    add("熱浴・熱流（1機あたり）", "C_H", small(CONFIG.hotCapacity) + " J/K", "高温側の熱容量");
    add("熱浴・熱流（1機あたり）", "C_C", small(CONFIG.coldCapacity) + " J/K", "低温側の熱容量");
    add("熱浴・熱流（1機あたり）", "P_H", small(ph) + " W", "炉から入る実際の加熱率");
    add("熱浴・熱流（1機あたり）", "Qdot_H", small(f.qh) + " W", "機関に入る熱流");
    add("熱浴・熱流（1機あたり）", "Wdot", small(f.w) + " W", "機関の仕事率");
    add("熱浴・熱流（1機あたり）", "Qdot_C", small(f.qc) + " W", "機関から捨てる熱流");
    add("熱浴・熱流（1機あたり）", "K(T_H - T_C)", small(f.leak) + " W", "直接の熱漏れ");
    add("熱浴・熱流（1機あたり）", "K_C(T_C - T₀)", small(f.dump) + " W", "外部環境へ放出する熱流");
    add("熱浴・熱流（1機あたり）", "dT_H/dt", small((ph - f.qh - f.leak) / CONFIG.hotCapacity) + " K/s", "モデルの瞬間温度変化率");
    add("熱浴・熱流（1機あたり）", "dT_C/dt", small((f.qc + f.leak - f.dump) / CONFIG.coldCapacity) + " K/s", "モデルの瞬間温度変化率");
    add("負荷・効率・cascade", "u", small(p.u), "有効な負荷（割合）");
    add("負荷・効率・cascade", "load level", "" + load.level, "負荷セレクタのレベル");
    add("負荷・効率・cascade", "G₀", small(0.05 * (1 + 0.25 * level(2))) + " W/K", "熱交換器の基礎係数");
    add("負荷・効率・cascade", "G", small(p.g) + " W/K", "負荷・cascade抵抗を含む熱交換係数");
    add("負荷・効率・cascade", "P coupling", small(p.p) + " W/K", "炉との熱結合係数");
    add("負荷・効率・cascade", "K", small(p.k) + " W/K", "熱漏れ係数");
    add("負荷・効率・cascade", "K_C", small(p.kc) + " W/K", "冷却係数");
    add("負荷・効率・cascade", "ε₀", small(0.38 + 0.5 * (1 - Math.exp(-level(5) / 8))), "無負荷でのcraftsmanship");
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
    add("entropy・fleet", "(1 + Σ/100)^β", big(entropyFactor(sigma)), "entropy生産因子 / " + on(1));
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
var getEquationOverlay = () => ui.createGrid({
    inputTransparent: true, cascadeInputTransparent: false,
    children: [
        ui.createButton({
            text: "全変数", fontSize: 12, widthRequest: 82, heightRequest: 30,
            horizontalOptions: LayoutOptions.START, verticalOptions: LayoutOptions.START,
            onClicked: () => showAllVariables()
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
        if (Number.isFinite(s.hot) && Number.isFinite(s.cold) && s.cold >= CONFIG.ambient && s.hot >= s.cold && s.hot <= CONFIG.furnace) {
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
    hot = 700; cold = 320; sigma = BigNumber.ZERO; lastRate = BigNumber.ZERO;
    load.level = 5; stages.level = 0;
    lastFlow = flows(hot, cold, physicalParameters());
    refresh();
};
init();
