data {
  int<lower=0> N;
  vector[N] y;
}
parameters {
  real mu;
}
model {
  y ~ normal(mu, sigma);
}
