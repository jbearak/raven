source("helpers.R")

survey <- clean_names(read.csv("survey.csv"))
summary(servey$age)

plot(fit)
fit <- lm(age ~ income, data = survey)
