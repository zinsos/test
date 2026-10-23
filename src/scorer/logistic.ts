export interface LogisticFit {
  intercept: number;
  coefficients: Float64Array;
  iterations: number;
  converged: boolean;
}

export interface LogisticOptions {
  l2: number;
  maxIterations: number;
  tolerance: number;
}

const MIN_WEIGHT = 1e-10;
const MAX_STEP_HALVINGS = 12;

export function sigmoid(z: number): number {
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function linear(beta: Float64Array, x: Float64Array, row: number, p: number): number {
  let z = beta[0] ?? 0;
  const offset = row * p;
  for (let j = 0; j < p; j += 1) {
    z += (beta[j + 1] ?? 0) * (x[offset + j] ?? 0);
  }
  return z;
}

function penalizedLogLikelihood(beta: Float64Array, x: Float64Array, y: Uint8Array, n: number, p: number, l2: number): number {
  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const z = linear(beta, x, i, p);
    const logOnePlusExp = z > 0 ? z + Math.log1p(Math.exp(-z)) : Math.log1p(Math.exp(z));
    total += (y[i] ?? 0) * z - logOnePlusExp;
  }
  let penalty = 0;
  for (let j = 1; j <= p; j += 1) {
    const value = beta[j] ?? 0;
    penalty += value * value;
  }
  return total - 0.5 * l2 * penalty;
}

export function solveLinearSystem(matrix: Float64Array, rhs: Float64Array, size: number): Float64Array {
  const a = Float64Array.from(matrix);
  const b = Float64Array.from(rhs);
  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    let best = Math.abs(a[col * size + col] ?? 0);
    for (let row = col + 1; row < size; row += 1) {
      const candidate = Math.abs(a[row * size + col] ?? 0);
      if (candidate > best) {
        best = candidate;
        pivot = row;
      }
    }
    if (best < 1e-14) {
      continue;
    }
    if (pivot !== col) {
      for (let k = 0; k < size; k += 1) {
        const tmp = a[col * size + k] ?? 0;
        a[col * size + k] = a[pivot * size + k] ?? 0;
        a[pivot * size + k] = tmp;
      }
      const tmp = b[col] ?? 0;
      b[col] = b[pivot] ?? 0;
      b[pivot] = tmp;
    }
    const diagonal = a[col * size + col] ?? 1;
    for (let row = col + 1; row < size; row += 1) {
      const factor = (a[row * size + col] ?? 0) / diagonal;
      if (factor === 0) {
        continue;
      }
      for (let k = col; k < size; k += 1) {
        a[row * size + k] = (a[row * size + k] ?? 0) - factor * (a[col * size + k] ?? 0);
      }
      b[row] = (b[row] ?? 0) - factor * (b[col] ?? 0);
    }
  }
  const solution = new Float64Array(size);
  for (let row = size - 1; row >= 0; row -= 1) {
    let acc = b[row] ?? 0;
    for (let k = row + 1; k < size; k += 1) {
      acc -= (a[row * size + k] ?? 0) * (solution[k] ?? 0);
    }
    const diagonal = a[row * size + row] ?? 0;
    solution[row] = Math.abs(diagonal) < 1e-14 ? 0 : acc / diagonal;
  }
  return solution;
}

function newtonSystem(
  beta: Float64Array,
  x: Float64Array,
  y: Uint8Array,
  n: number,
  p: number,
  l2: number
): { hessian: Float64Array; gradient: Float64Array } {
  const size = p + 1;
  const hessian = new Float64Array(size * size);
  const gradient = new Float64Array(size);
  const row = new Float64Array(size);
  row[0] = 1;
  for (let i = 0; i < n; i += 1) {
    const offset = i * p;
    for (let j = 0; j < p; j += 1) {
      row[j + 1] = x[offset + j] ?? 0;
    }
    const mu = sigmoid(linear(beta, x, i, p));
    const weight = Math.max(MIN_WEIGHT, mu * (1 - mu));
    const residual = (y[i] ?? 0) - mu;
    for (let a = 0; a < size; a += 1) {
      const ra = row[a] ?? 0;
      gradient[a] = (gradient[a] ?? 0) + residual * ra;
      const wa = weight * ra;
      for (let b = a; b < size; b += 1) {
        hessian[a * size + b] = (hessian[a * size + b] ?? 0) + wa * (row[b] ?? 0);
      }
    }
  }
  for (let a = 0; a < size; a += 1) {
    for (let b = 0; b < a; b += 1) {
      hessian[a * size + b] = hessian[b * size + a] ?? 0;
    }
  }
  for (let j = 1; j < size; j += 1) {
    hessian[j * size + j] = (hessian[j * size + j] ?? 0) + l2;
    gradient[j] = (gradient[j] ?? 0) - l2 * (beta[j] ?? 0);
  }
  return { hessian, gradient };
}

export function fitLogistic(x: Float64Array, y: Uint8Array, n: number, p: number, options: LogisticOptions): LogisticFit {
  const size = p + 1;
  let beta = new Float64Array(size);
  let positives = 0;
  for (let i = 0; i < n; i += 1) {
    positives += y[i] ?? 0;
  }
  const rate = Math.min(1 - 1e-6, Math.max(1e-6, n > 0 ? positives / n : 0.5));
  beta[0] = Math.log(rate / (1 - rate));
  let current = penalizedLogLikelihood(beta, x, y, n, p, options.l2);
  let iterations = 0;
  let converged = false;
  while (iterations < options.maxIterations) {
    iterations += 1;
    const { hessian, gradient } = newtonSystem(beta, x, y, n, p, options.l2);
    const step = solveLinearSystem(hessian, gradient, size);
    let scale = 1;
    let candidate = beta;
    let candidateValue = current;
    for (let halving = 0; halving <= MAX_STEP_HALVINGS; halving += 1) {
      const trial = new Float64Array(size);
      for (let j = 0; j < size; j += 1) {
        trial[j] = (beta[j] ?? 0) + scale * (step[j] ?? 0);
      }
      const value = penalizedLogLikelihood(trial, x, y, n, p, options.l2);
      if (value >= current - 1e-12) {
        candidate = trial;
        candidateValue = value;
        break;
      }
      scale /= 2;
    }
    let maxChange = 0;
    for (let j = 0; j < size; j += 1) {
      maxChange = Math.max(maxChange, Math.abs((candidate[j] ?? 0) - (beta[j] ?? 0)));
    }
    beta = candidate;
    current = candidateValue;
    if (maxChange < options.tolerance) {
      converged = true;
      break;
    }
  }
  return { intercept: beta[0] ?? 0, coefficients: beta.slice(1), iterations, converged };
}

export function predictLogistic(fit: LogisticFit, row: ArrayLike<number>): number {
  let z = fit.intercept;
  for (let j = 0; j < fit.coefficients.length; j += 1) {
    z += (fit.coefficients[j] ?? 0) * (row[j] ?? 0);
  }
  return sigmoid(z);
}
