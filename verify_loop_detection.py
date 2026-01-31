#!/usr/bin/env python3
"""
Simple verification script to test loop iterator detection.
This simulates what the Rust code should do.
"""

def test_for_loop_parsing():
    """Test that we can identify for loop patterns"""
    test_cases = [
        "for (i in 1:10) { print(i) }",
        "for (item in my_list) { process(item) }",
        "for (j in 1:5) { }\nresult <- j",
        "for (i in 1:3) { for (j in 1:2) { print(i, j) } }",
    ]
    
    expected_iterators = [
        ["i"],
        ["item"],
        ["j"],
        ["i", "j"],
    ]
    
    print("Testing for loop iterator detection:")
    for i, (code, expected) in enumerate(zip(test_cases, expected_iterators)):
        print(f"\nTest {i+1}: {code}")
        print(f"Expected iterators: {expected}")
        
        # Simple regex-based detection (simulating tree-sitter parsing)
        import re
        matches = re.findall(r'for\s*\(\s*(\w+)\s+in\s+', code)
        print(f"Detected iterators: {matches}")
        
        if set(matches) == set(expected):
            print("✓ PASS")
        else:
            print("✗ FAIL")

if __name__ == "__main__":
    test_for_loop_parsing()