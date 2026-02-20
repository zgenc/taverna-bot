package api // Kendi klasör yapına göre paket adını güncelle

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
)

// Tavily API istek ve yanıt yapıları
type TavilyRequest struct {
	APIKey string `json:"api_key"`
	Query  string `json:"query"`
}

type TavilyResponse struct {
	Results []struct {
		Content string `json:"content"`
	} `json:"results"`
}

// SearchWeb, aldığı sorguyu Tavily'de arar ve birleştirilmiş metin döner
func SearchWeb(query string) (string, error) {
	apiKey := os.Getenv("TAVILY_API_KEY")
	if apiKey == "" {
		return "", fmt.Errorf("TAVILY_API_KEY bulunamadı")
	}

	reqBody, _ := json.Marshal(TavilyRequest{
		APIKey: apiKey,
		Query:  query,
	})

	resp, err := http.Post("https://api.tavily.com/search", "application/json", bytes.NewBuffer(reqBody))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	body, _ := io.ReadAll(resp.Body)
	var result TavilyResponse
	json.Unmarshal(body, &result)

	var context string
	for _, res := range result.Results {
		context += res.Content + "\n"
	}
	return context, nil
}
