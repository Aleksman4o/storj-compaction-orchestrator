package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"
)

var version = "development"

func main() {
	listenDefault := envOr("COMPACTION_ORCHESTRATOR_LISTEN", "0.0.0.0:14008")
	databaseDefault := envOr("COMPACTION_ORCHESTRATOR_DATABASE", executableDatabasePath())
	listen := flag.String("listen", listenDefault, "HTTP listen address")
	database := flag.String("database", databaseDefault, "SQLite database path")
	showVersion := flag.Bool("version", false, "print version")
	flag.Parse()
	if *showVersion {
		fmt.Println(version)
		return
	}

	log := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		log.Error("listen", "address", *listen, "error", err)
		os.Exit(1)
	}
	defer listener.Close()

	orchestrator, err := newOrchestrator(ctx, *database, log)
	if err != nil {
		log.Error("initialize orchestrator", "error", err)
		os.Exit(1)
	}
	defer orchestrator.close()

	password := envOr("COMPACTION_ORCHESTRATOR_PASSWORD", "orchestra")
	api, err := newAPIServer(orchestrator, password)
	if err != nil {
		log.Error("initialize dashboard", "error", err)
		os.Exit(1)
	}
	server := &http.Server{
		Addr:              *listen,
		Handler:           api.handler(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownCtx)
	}()

	log.Info("compaction orchestrator started", "version", version, "address", listener.Addr(), "database", *database)
	if password == "orchestra" {
		log.Warn("dashboard uses the default password; set COMPACTION_ORCHESTRATOR_PASSWORD before exposing it to an untrusted network")
	}
	if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Error("serve dashboard", "error", err)
		os.Exit(1)
	}
}

func executableDatabasePath() string {
	executable, err := os.Executable()
	if err != nil {
		return "orchestrator.db"
	}
	return filepath.Join(filepath.Dir(executable), "orchestrator.db")
}

func envOr(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
