package main

import (
	"os"
	"os/exec"
	"path/filepath"
)

func main() {
	launcherPath, err := os.Executable()
	if err != nil {
		return
	}
	dir := filepath.Dir(launcherPath)
	core := filepath.Join(dir, "Arduino IDE Agent Core.exe")
	args := []string{"--no-sandbox", "--disable-gpu"}
	args = append(args, os.Args[1:]...)
	command := exec.Command(core, args...)
	command.Dir = dir
	command.Stdin = os.Stdin
	command.Stdout = os.Stdout
	command.Stderr = os.Stderr
	_ = command.Run()
}
