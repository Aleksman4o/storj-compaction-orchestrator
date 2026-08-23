package main

import "testing"

func TestCompactionEndpoint(t *testing.T) {
	got, err := compactionEndpoint("http://127.0.0.1:14002/", "/start")
	if err != nil {
		t.Fatal(err)
	}
	if got != "http://127.0.0.1:14002/api/sno/compaction/start" {
		t.Fatalf("unexpected endpoint %q", got)
	}
	for _, invalid := range []string{"127.0.0.1:14002", "ftp://node", "http://user:pass@node"} {
		if _, err := compactionEndpoint(invalid, ""); err == nil {
			t.Fatalf("expected %q to be rejected", invalid)
		}
	}
}

func TestValidateAPIKey(t *testing.T) {
	if err := validateAPIKey(testKey()); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"", "not-base64", "YQ=="} {
		if err := validateAPIKey(key); err == nil {
			t.Fatalf("expected invalid key %q to be rejected", key)
		}
	}
}
