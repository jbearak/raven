/// Built-in types, block keywords, control flow, and functions for the Stan language.
///
/// These lists are used by the completion handler to provide Stan-specific
/// suggestions when editing `.stan` files.

pub static STAN_TYPES: &[&str] = &[
    "int",
    "real",
    "vector",
    "row_vector",
    "matrix",
    "simplex",
    "unit_vector",
    "ordered",
    "positive_ordered",
    "corr_matrix",
    "cov_matrix",
    "cholesky_factor_corr",
    "cholesky_factor_cov",
    "void",
    "array",
    "complex",
    "complex_vector",
    "complex_row_vector",
    "complex_matrix",
    "tuple",
];

pub static STAN_BLOCK_KEYWORDS: &[&str] = &[
    "functions",
    "data",
    "transformed data",
    "parameters",
    "transformed parameters",
    "model",
    "generated quantities",
];

pub static STAN_CONTROL_FLOW: &[&str] = &[
    "for",
    "in",
    "while",
    "if",
    "else",
    "return",
    "break",
    "continue",
    "print",
    "reject",
    "profile",
];

pub static STAN_FUNCTIONS: &[&str] = &[
    "log",
    "exp",
    "sqrt",
    "fabs",
    "inv_logit",
    "logit",
    "softmax",
    "to_vector",
    "to_matrix",
    "to_array_1d",
    "rep_vector",
    "rep_matrix",
    "append_row",
    "append_col",
    "normal_lpdf",
    "bernoulli_lpmf",
    "normal_rng",
    "bernoulli_rng",
    "gamma_lpdf",
    "poisson_lpmf",
    "beta_lpdf",
    "uniform_lpdf",
    "cauchy_lpdf",
    "student_t_lpdf",
    "multi_normal_lpdf",
    "lkj_corr_lpdf",
    "dirichlet_lpdf",
];
