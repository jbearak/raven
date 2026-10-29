cars <- data.frame(mpg = c(21, 33), cyl = c(6, 4))
ratio <- with(cars, mpg / cyl)
label <- paste(missing_label, ratio)
