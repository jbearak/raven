# Test fixture: forward reference at top level should be flagged.
# food is used before it's defined — sentinel_undefined is also undefined.
apple <- food
bar <- food
food <- 1
sentinel_undefined_fwdref <- 1
z <- sentinel_undefined_fwdref_usage
